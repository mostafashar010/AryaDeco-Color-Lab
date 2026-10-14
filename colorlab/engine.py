"""Local computational color estimates, not instrument or spectral measurements.

XYZ is relative Y=1, observer 2 degrees. Camera-domain values are linear sRGB
coordinates, potentially outside its gamut. Only catalog_color clamps gamut.
"""

import io
import struct
import hashlib
import uuid
from scipy.ndimage import median_filter
from scipy.signal import find_peaks
from scipy.spatial import ConvexHull, QhullError

from PIL import Image, ImageCms
import numpy as np
import colour


WHITES = {'D65': np.array([0.950455927051672, 1., 1.089057750759878]),
          'D50': np.array([0.964295676429568, 1., 0.82510460251046])}
MATRICES = {
    'srgb': np.array([[0.41239079926596, 0.35758433938388, 0.18048078840183],
                      [0.21263900587151, 0.71516867876776, 0.07219231536073],
                      [0.01933081871559, 0.11919477979463, 0.95053215224966]]),
    'display-p3': np.array([[0.48657094864822, 0.26566769316909, 0.19821728523436],
                            [0.22897456406975, 0.69173852183651, 0.07928691409375],
                            [0., 0.04511338185890, 1.04394436890098]])}


def _triples(value):
    a = np.asarray(value, dtype=float)
    if a.ndim == 0 or a.shape[-1] != 3 or not np.all(np.isfinite(a)):
        raise ValueError('Expected finite RGB/XYZ/Lab triples')
    return a


def _linear(rgb):
    a = _triples(rgb)
    return np.where(a <= .04045, a / 12.92, ((np.maximum(a, 0) + .055) / 1.055) ** 2.4)


def _encoded(rgb):
    a = _triples(rgb)
    return np.where(a <= .0031308, 12.92 * a, 1.055 * np.maximum(a, 0) ** (1 / 2.4) - .055)


def rgb_to_xyz(rgb, space='srgb'):
    if space not in MATRICES:
        raise ValueError('Unsupported RGB space')
    return _linear(rgb) @ MATRICES[space].T


def xyz_to_lab(xyz, white='D65'):
    if white not in WHITES: raise ValueError('Unsupported reference white')
    a = _triples(xyz) / WHITES[white]
    d = 6 / 29
    f = np.where(a > d ** 3, np.cbrt(a), a / (3 * d ** 2) + 4 / 29)
    return np.stack((116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])), axis=-1)


def lab_to_xyz(lab, white='D65'):
    if white not in WHITES: raise ValueError('Unsupported reference white')
    a = _triples(lab)
    y = (a[..., 0] + 16) / 116
    f = np.stack((y + a[..., 1] / 500, y, y - a[..., 2] / 200), axis=-1)
    d = 6 / 29
    return np.where(f > d, f ** 3, 3 * d ** 2 * (f - 4 / 29)) * WHITES[white]


def adapt_xyz(xyz, source='D50', target='D65'):
    if source not in WHITES or target not in WHITES: raise ValueError('Unsupported reference white')
    a = _triples(xyz)
    b = np.array([[.8951, .2664, -.1614], [-.7502, 1.7135, .0367], [.0389, -.0685, 1.0296]])
    m = np.linalg.inv(b) @ np.diag((b @ WHITES[target]) / (b @ WHITES[source])) @ b
    return a @ m.T


def delta_e00(lab1, lab2):
    return colour.delta_E(_triples(lab1), _triples(lab2), method='CIE 2000')


def catalog_color(xyz):
    a = _triples(xyz)
    if a.shape != (3,):
        raise ValueError('Catalog color requires one XYZ triple')
    linear = a @ np.linalg.inv(MATRICES['srgb']).T
    encoded = _encoded(linear)
    clamped = np.clip(encoded, 0, 1)
    rgb8 = np.floor(clamped * 255 + .5).astype(int)
    return {'rgb': clamped.tolist(), 'hex': '#' + ''.join(f'{x:02X}' for x in rgb8),
            'unclippedRgb': encoded.tolist(),
            'outOfGamut': bool(np.any(linear < -1e-8) or np.any(linear > 1 + 1e-8)),
            'xyz': a.tolist(), 'lab': xyz_to_lab(a).tolist(),
            'referenceWhite': 'D65', 'physicallyVerified': False}


def _icc_xyz(rgb, data):
    try:
        profile = ImageCms.ImageCmsProfile(io.BytesIO(data))
        if data[16:20] != b'RGB ' or data[20:24] != b'XYZ ' or len(data) < 132:
            raise ValueError('Unsupported ICC color space / PCS')
        count = struct.unpack_from('>I', data, 128)[0]
        if count > 128 or 132 + count * 12 > len(data):
            raise ValueError('Invalid ICC tag table')
        tags = {}
        for i in range(count):
            name, offset, size = struct.unpack_from('>4sII', data, 132 + 12*i)
            if offset < 128 or size < 8 or offset + size > len(data):
                raise ValueError('Invalid ICC tag bounds')
            tags[name] = data[offset:offset+size]
        if any(k.startswith((b'A2B', b'B2A', b'D2B', b'B2D')) for k in tags):
            raise ValueError('Unsupported LUT ICC profile')
        matrix, channels = [], []
        for channel in (b'r', b'g', b'b'):
            xyz = tags[channel + b'XYZ']
            if xyz[:4] != b'XYZ ':
                raise ValueError('Unsupported ICC matrix tag')
            matrix.append(np.array(struct.unpack_from('>iii', xyz, 8)) / 65536)
            curve = tags[channel + b'TRC']
            x = rgb[..., len(channels)]
            if curve[:4] == b'curv':
                n = struct.unpack_from('>I', curve, 8)[0]
                if n == 0:
                    y = x
                elif n == 1:
                    y = x ** (struct.unpack_from('>H', curve, 12)[0] / 256)
                elif 2 <= n <= 65536:
                    values = np.asarray(struct.unpack_from(f'>{n}H', curve, 12)) / 65535
                    if np.any(np.diff(values) < 0):
                        raise ValueError('Nonmonotonic ICC TRC')
                    y = np.interp(x, np.linspace(0, 1, n), values)
                else:
                    raise ValueError('Unsupported ICC TRC size')
            elif curve[:4] == b'para':
                kind = struct.unpack_from('>H', curve, 8)[0]
                counts = {0: 1, 1: 3, 2: 4, 3: 5, 4: 7}
                if kind not in counts:
                    raise ValueError('Unsupported ICC parametric TRC')
                p = np.array(struct.unpack_from(f'>{counts[kind]}i', curve, 12)) / 65536
                g = p[0]
                if g <= 0:
                    raise ValueError('Invalid ICC gamma')
                if kind == 0:
                    y = x ** g
                else:
                    a, b = p[1:3]
                    if a <= 0:
                        raise ValueError('Invalid ICC TRC slope')
                    power = np.maximum(a*x+b, 0) ** g
                    if kind == 1:
                        y = np.where(x >= -b/a, power, 0)
                    elif kind == 2:
                        y = np.where(x >= -b/a, power+p[3], p[3])
                    elif kind == 3:
                        y = np.where(x >= p[4], power, p[3]*x)
                    else:
                        y = np.where(x >= p[4], power+p[5], p[3]*x+p[6])
            else:
                raise ValueError('Unsupported ICC TRC tag')
            channels.append(y)
        matrix = np.array(matrix).T
        if np.linalg.matrix_rank(matrix) != 3 or np.linalg.cond(matrix) > 100:
            raise ValueError('Invalid ICC RGB matrix')
        xyz = np.stack(channels, axis=-1) @ matrix.T
        d65_matrix = adapt_xyz(matrix.T).T
        space = next((name for name, known in MATRICES.items()
                      if np.allclose(d65_matrix, known, atol=.001)), 'icc-rgb')
        return adapt_xyz(xyz), ImageCms.getProfileDescription(profile).strip(), space
    except (KeyError, struct.error, OSError, TypeError) as exc:
        raise ValueError('Invalid or unsupported ICC profile') from exc


def decode_image(data: bytes, assumed_space=None):
    if assumed_space == 'canonical-srgb':
        raise ValueError('Canonical image already converted; do not reapply original ICC')
    if assumed_space not in (None, 'srgb', 'display-p3'):
        raise ValueError('Unsupported assumed color space')
    try:
        image = Image.open(io.BytesIO(data))
        if image.width * image.height > 30_000_000 or getattr(image, 'n_frames', 1) != 1:
            raise ValueError('Image too large or animated')
        if image.mode not in ('RGB', 'RGBA'):
            raise ValueError('Only 8-bit RGB original images supported')
        pixels = np.asarray(image, dtype=float) / 255
        if image.mode == 'RGBA' and np.any(pixels[..., 3] != 1):
            raise ValueError('Transparent pixels have no unambiguous color')
        pixels = pixels[..., :3]
        icc = image.info.get('icc_profile')
        if icc:
            xyz, description, source_space = _icc_xyz(pixels, icc)
            rgb = _encoded(xyz @ np.linalg.inv(MATRICES['srgb']).T)
        else:
            description = assumed_space or 'srgb'
            source_space = description
            rgb = _encoded(rgb_to_xyz(pixels, description) @ np.linalg.inv(MATRICES['srgb']).T)
        return {'rgb': rgb, 'metadata': {
            'colorSpace': 'srgb', 'sourceColorSpace': source_space, 'iccDescription': description if icc else None,
            'encoding': 'encoded',
            'iccApplied': bool(icc), 'iccSha256': hashlib.sha256(icc).hexdigest() if icc else None,
            'assumed': not bool(icc), 'exploratory': True, 'physicallyVerified': False,
            'originalSha256': hashlib.sha256(data).hexdigest(),
            'width': image.width, 'height': image.height,
            'orientation': image.getexif().get(274, 1), 'gamutPreserved': True}}
    except (OSError, Image.DecompressionBombError) as exc:
        raise ValueError('Invalid encoded image') from exc


def summarize_frames(frames, min_frames=10, min_span_ms=1000):
    if not 1 <= min_frames <= 100 or not np.isfinite(min_span_ms) or min_span_ms < 0:
        raise ValueError('Invalid sampling limits')
    if len(frames) > 100:
        raise ValueError('Too many frames')
    warnings, centers, block_centers, ids, times, fingerprints = [], [], [], [], [], []
    valid_pixels = excluded = total = clipped = 0
    block_counts = []
    video_ids, media_times = [], []
    within_distances = []
    for frame in frames:
        pixels = _triples(frame['pixels'])
        blocks = np.asarray(frame['blockIds'])
        if (pixels.ndim != 2 or not 1 <= len(pixels) <= 8192 or blocks.shape != (len(pixels),)
                or not np.issubdtype(blocks.dtype, np.integer) or np.any(blocks < 0)
                or np.any(pixels < 0) or np.any(pixels > 1) or frame['encoding'] != 'encoded'
                or frame['colorSpace'] not in MATRICES or frame['source'] not in ('videoCanvas', 'replay')):
            raise ValueError('Malformed encoded frame')
        count, removed = frame['pixelCount'], frame['excludedCount']
        if (not isinstance(count, int) or not isinstance(removed, int) or removed < 0
                or count < len(pixels)+removed):
            raise ValueError('Invalid sample counts')
        if not frame['id'] or not np.isfinite(frame['capturedAt']) or not frame['settingsFingerprint']:
            raise ValueError('Missing frame identity / settings')
        ids.append(frame['id']); times.append(frame['capturedAt']); fingerprints.append(frame['settingsFingerprint'])
        if frame.get('presentedFrames') is not None:
            video_ids.append(frame['presentedFrames'])
        if frame.get('mediaTime') is not None:
            if not np.isfinite(frame['mediaTime']) or frame['mediaTime'] < 0:
                raise ValueError('Invalid video media time')
            media_times.append(frame['mediaTime'])
        clipped += int(np.count_nonzero(np.any((pixels <= 1/255) | (pixels >= 254/255), axis=1)))
        linear = rgb_to_xyz(pixels, frame['colorSpace']) @ np.linalg.inv(MATRICES['srgb']).T
        medians = [np.median(linear[blocks == block], axis=0) for block in np.unique(blocks)
                   if np.count_nonzero(blocks == block) >= 4]
        for block in np.unique(blocks):
            sample = linear[blocks == block]
            if len(sample) >= 4:
                within_distances.extend(np.linalg.norm(sample-np.median(sample,axis=0),axis=1))
        block_counts.append(len(medians))
        if medians:
            medians = np.asarray(medians)
            center = np.median(medians, axis=0)
            centers.append(center)
            block_centers.append(float(np.max(np.linalg.norm(medians-center, axis=1))))
        valid_pixels += len(pixels); excluded += removed; total += count
    unique = len(set(ids))
    span = max(times)-min(times) if times else 0
    temporal = float(np.max(np.std(centers, axis=0))) if centers else 0.
    spread = max(block_centers, default=0.)
    within_spread = float(np.percentile(within_distances,90)) if within_distances else 0.
    excluded_rate = excluded / total if total else 0.
    clip_rate = clipped / valid_pixels if valid_pixels else 0.
    if unique != len(ids): warnings.append('duplicate-frame')
    if (video_ids and len(set(video_ids)) != len(video_ids)
            or media_times and len(set(media_times)) != len(media_times)):
        warnings.append('duplicate-video-frame')
    if media_times and np.any(np.diff(media_times) <= 0): warnings.append('stale-video-frame')
    if unique < min_frames: warnings.append('insufficient-frames')
    if span < min_span_ms: warnings.append('insufficient-span')
    if len(times) > 1 and np.any(np.diff(times) <= 0): warnings.append('stale-frame')
    if len(set(fingerprints)) > 1: warnings.append('settings-changed')
    if len(set(f['source'] for f in frames)) > 1: warnings.append('source-changed')
    if len(set(f['colorSpace'] for f in frames)) > 1: warnings.append('color-space-changed')
    if min(block_counts, default=0) < 4: warnings.append('insufficient-blocks')
    if clip_rate > .02: warnings.append('clipped-pixels')
    if excluded_rate > .5: warnings.append('excessive-exclusions')
    if temporal > .01: warnings.append('temporal-instability')
    if spread > .08: warnings.append('spatial-nonuniformity')
    if within_spread > .08: warnings.append('within-block-nonuniformity')
    return {'rgb': np.median(centers, axis=0).tolist() if centers else None,
            'quality': {'status': 'rejected' if warnings else 'accepted', 'warnings': warnings,
                        'uniqueFrames': unique, 'validPixels': valid_pixels,
                        'validBlocks': min(block_counts, default=0), 'excludedRate': excluded_rate,
                        'temporalStd': temporal, 'blockSpread': spread, 'clippedRate': clip_rate,
                        'withinBlockSpread':within_spread,
                        'spanMs': float(span), 'domain': 'linear-srgb-camera',
                        'sharpnessStatus':'notAssessed',
                        'videoIdentityStatus':'reported' if video_ids or media_times else 'notReported'}}


def fit_camera(target, observations):
    if target.get('exploratory') is True:
        return {'id': str(uuid.uuid4()), 'status': 'exploratory', 'matrix': None,
                'trainingPatchIds': [], 'holdoutPatchIds': [], 'validation': None,
                'physicallyVerified': False}
    if (target.get('validity') != 'verified' or target.get('observer') != '2'
            or target.get('xyzScale') != 1 or target.get('referenceWhite') not in WHITES
            or target.get('valueType') not in ('XYZ', 'Lab')
            or any(not target.get(k) for k in ('id', 'source', 'version'))):
        raise ValueError('Verified observer 2 reference with documented source required')
    patches = target['patches']
    ids = [p['id'] for p in patches]
    obs_ids = [o['patchId'] for o in observations]
    if len(set(ids)) != len(ids) or len(set(obs_ids)) != len(obs_ids) or set(ids) != set(obs_ids):
        raise ValueError('Unique disjoint physical patch IDs and complete observation coverage required')
    train = [p['id'] for p in patches if p['split'] == 'train']
    holdout = [p['id'] for p in patches if p['split'] == 'holdout']
    if len(train) < 6 or len(holdout) < 3 or len(train)+len(holdout) != len(patches):
        raise ValueError('At least six training and three held-out physical patches required')
    if (sum(not p['neutral'] for p in patches if p['split'] == 'train') < 3
            or all(p['neutral'] for p in patches if p['split'] == 'holdout')):
        raise ValueError('Neutral-only cannot identify full color transform; use exploratory')
    observations = {o['patchId']: o for o in observations}
    settings = {f['settingsFingerprint'] for o in observations.values() for f in o['frames']}
    if len(settings) != 1:
        raise ValueError('Camera settings changed across reference patches')
    if any(f['source'] != 'videoCanvas' for o in observations.values() for f in o['frames']):
        raise ValueError('Referenced camera fit requires live captures, not replay')
    x, y = [], []
    seen_frames = set()
    seen_video = set()
    proven_rois = []
    roi_provenance = any(f.get('roi') is not None for o in observations.values() for f in o['frames'])
    if not roi_provenance:
        raise ValueError('Physical patch ROI provenance required; IDs alone are not evidence')
    for p in patches:
        f = observations[p['id']]['frames']
        if roi_provenance:
            first = f[0]
            if (not first.get('regionId') or first.get('roi') is None
                    or not isinstance(first.get('width'),int) or not isinstance(first.get('height'),int)
                    or min(first['width'],first['height']) <= 0):
                raise ValueError('Physical patch ROI provenance required')
            points = np.asarray(first['roi'],dtype=float)
            _polygon_mask((1,1),points)  # Validate normalized polygon without rasterizing full image.
            signature = (first['regionId'],first['width'],first['height'],points.tolist())
            for a in f:
                if (a.get('regionId'),a.get('width'),a.get('height'),a.get('roi')) != signature:
                    raise ValueError('Physical patch ROI changed during capture')
            low,high = points.min(axis=0),points.max(axis=0)
            if np.any(high <= low): raise ValueError('Degenerate physical patch ROI')
            for region_id,width,height,old_low,old_high in proven_rois:
                if (width,height) != (first['width'],first['height']):
                    raise ValueError('ROI original dimensions differ')
                if region_id == first['regionId'] or np.all(np.minimum(high,old_high)>np.maximum(low,old_low)):
                    raise ValueError('Physical patch ROI reused or not proven disjoint')
            proven_rois.append((first['regionId'],first['width'],first['height'],low,high))
        frame_ids = {a['id'] for a in f}
        if seen_frames.intersection(frame_ids) and not roi_provenance:
            raise ValueError('Reused capture identity between physical patches')
        seen_frames.update(frame_ids)
        video = {(key,a[key]) for a in f for key in ('mediaTime','presentedFrames') if a.get(key) is not None}
        if seen_video & video and not roi_provenance:
            raise ValueError('Reused actual video capture between physical patches')
        seen_video.update(video)
        summary = summarize_frames(f)
        if summary['quality']['status'] != 'accepted':
            raise ValueError('Rejected camera patch capture')
        xyz = _triples(p['values'])
        if xyz.shape != (3,):
            raise ValueError('Reference requires a single triple per patch')
        if target['valueType'] == 'Lab': xyz = lab_to_xyz(xyz, target['referenceWhite'])
        if np.any(xyz < 0) or xyz[1] > 1.5:
            raise ValueError('Invalid relative XYZ reference scale')
        x.append(summary['rgb']); y.append(adapt_xyz(xyz, target['referenceWhite'], 'D65'))
    x, y = np.array(x), np.array(y)
    mask = np.array([p['split'] == 'train' for p in patches])
    rank = int(np.linalg.matrix_rank(x[mask]))
    condition = float(np.linalg.cond(x[mask]))
    chroma = y[mask] / np.maximum(y[mask].sum(axis=1, keepdims=True), 1e-12)
    if rank < 3 or condition > 100 or np.linalg.matrix_rank(chroma-chroma.mean(axis=0), tol=.01) < 2:
        raise ValueError('Insufficient chromatic/rank coverage')
    regularization = 1e-8
    try:
        hull = ConvexHull(x[mask])
    except QhullError as exc:
        raise ValueError('Insufficient volumetric training coverage') from exc
    matrix = np.linalg.solve(x[mask].T @ x[mask] + regularization*np.eye(3), x[mask].T @ y[mask]).T
    predicted = x[~mask] @ matrix.T
    errors = delta_e00(xyz_to_lab(predicted), xyz_to_lab(y[~mask]))
    before = delta_e00(xyz_to_lab(x[~mask] @ MATRICES['srgb'].T), xyz_to_lab(y[~mask]))
    statistics = lambda a: {'mean':float(np.mean(a)), 'median':float(np.median(a)),
                             'p95':float(np.percentile(a,95)), 'max':float(np.max(a))}
    if np.any(predicted < 0) or np.max(errors) > 5 or np.mean(errors) > 3:
        raise ValueError('Camera holdout validation failed')
    return {'id': str(uuid.uuid4()), 'status': 'referenced', 'matrix': matrix.tolist(),
            'cameraDomain':{'policy':'training-convex-hull', 'min':x[mask].min(axis=0).tolist(),
                            'max':x[mask].max(axis=0).tolist(), 'equations':hull.equations.tolist(),
                            'tolerance':1e-8},
            'trainingPatchIds': train, 'holdoutPatchIds': holdout,
            'referenceId': target['id'], 'referenceVersion': target['version'],
            'domain': 'linear-srgb-camera', 'referenceWhite': 'D65', 'observer': '2', 'xyzScale': 1,
            'physicallyVerified': False, 'validation': {'rank': rank, 'conditionNumber': condition,
                'regularization': regularization, 'meanDeltaE00': float(np.mean(errors)),
                'maxDeltaE00': float(np.max(errors)), 'independentInstrumentValidation': False,
                'before':statistics(before), 'after':statistics(errors),
                'perPatch':[{'patchId':p, 'beforeDeltaE00':float(b), 'afterDeltaE00':float(a)}
                            for p,b,a in zip(holdout,before,errors)]}}


def apply_camera(linear_rgb, profile):
    if profile.get('status') != 'referenced' or profile.get('matrix') is None:
        raise ValueError('No referenced camera matrix available')
    matrix = np.asarray(profile['matrix'], dtype=float)
    if matrix.shape != (3, 3) or not np.all(np.isfinite(matrix)):
        raise ValueError('Invalid camera matrix')
    rgb = _triples(linear_rgb)
    domain = profile.get('cameraDomain')
    if not domain or domain.get('policy') != 'training-convex-hull':
        raise ValueError('Missing safe camera training domain')
    equations = np.asarray(domain['equations'],dtype=float)
    if equations.ndim != 2 or equations.shape[1] != 4 or not np.all(np.isfinite(equations)):
        raise ValueError('Invalid camera training hull')
    if np.any(rgb @ equations[:,:3].T + equations[:,3] > 1e-8):
        raise ValueError('Camera sample outside training coverage')
    xyz = rgb @ matrix.T
    if not np.all(np.isfinite(xyz)) or np.any(xyz < 0) or np.any(xyz[...,1] > 1.5):
        raise ValueError('Camera transform produced invalid relative XYZ')
    return xyz


def check_witness(baseline, current, noise_floor=.002):
    if not np.isfinite(noise_floor) or noise_floor < 0:
        raise ValueError('Invalid witness noise floor')
    a, b = summarize_frames(baseline), summarize_frames(current)
    if a['quality']['status'] != 'accepted' or b['quality']['status'] != 'accepted':
        return False
    if set(x['id'] for x in baseline) & set(x['id'] for x in current):
        return False
    for key in ('mediaTime','presentedFrames'):
        old = {f[key] for f in baseline if f.get(key) is not None}
        new = {f[key] for f in current if f.get(key) is not None}
        if old & new: return False
    if baseline[0]['settingsFingerprint'] != current[0]['settingsFingerprint']:
        return False
    threshold = max(noise_floor * 3, a['quality']['temporalStd']*3, b['quality']['temporalStd']*3)
    return bool(np.linalg.norm(np.array(a['rgb'])-b['rgb']) / np.sqrt(3) <= threshold)


def fit_display(observations):
    if not 9 <= len(observations) <= 100:
        raise ValueError('Display requires at least nine observations')
    ids = [o['patchId'] for o in observations]
    commands = [o['commandSequence'] for o in observations]
    if len(set(ids)) != len(ids) or len(set(commands)) != len(commands):
        raise ValueError('Duplicate physical display observation')
    x, y, train, seen = [], [], [], set()
    seen_video = set()
    baseline = observations[0]['witnessFrames']
    if summarize_frames(baseline)['quality']['status'] != 'accepted':
        raise ValueError('Rejected physical witness baseline')
    cards = [o.get('cardFrames') for o in observations]
    has_cards = any(cards)
    if has_cards and (not all(cards) or len(set(o.get('cardPatchId') for o in observations)) != 1
                      or not observations[0].get('cardPatchId')):
        raise ValueError('Consistent observed physical card pairing required')
    if has_cards and summarize_frames(cards[0])['quality']['status'] != 'accepted':
        raise ValueError('Rejected physical card baseline')
    for i, o in enumerate(observations):
        drive = _triples(o['drive'])
        if drive.shape != (3,) or np.any(drive < 0) or np.any(drive > 1):
            raise ValueError('Invalid display drive')
        if i and not check_witness(baseline, o['witnessFrames']):
            raise ValueError('Unstable physical witness')
        if has_cards and i and not check_witness(cards[0], cards[i]):
            raise ValueError('Unstable observed physical card')
        groups = [o['frames'], o['witnessFrames']] + ([cards[i]] if has_cards else [])
        if any(f['source'] != 'videoCanvas' for group in groups for f in group):
            raise ValueError('Display response requires live physical captures')
        settings = {f['settingsFingerprint'] for group in groups for f in group}
        if len(settings) != 1:
            raise ValueError('Co-capture camera settings differ')
        for group in groups[1:]:
            key = 'mediaTime' if all(f.get('mediaTime') is not None for f in groups[0]+group) else 'capturedAt'
            times_a, times_b = [f[key] for f in groups[0]], [f[key] for f in group]
            margin = .1 if key=='mediaTime' else 100.
            if len(times_a) != len(times_b) or np.any(np.abs(np.array(times_a)-times_b) > margin):
                raise ValueError('Physical witness/card must co-capture with display patch')
            if any(f.get('presentedFrames') is not None for f in groups[0]+group):
                if any(a.get('presentedFrames') is None or a.get('presentedFrames') != b.get('presentedFrames')
                       for a,b in zip(groups[0],group)):
                    raise ValueError('Co-capture actual video identities differ')
        summary = summarize_frames(o['frames'])
        if summary['quality']['status'] != 'accepted':
            raise ValueError('Rejected display response capture')
        all_frames = o['frames'] + o['witnessFrames'] + (cards[i] if has_cards else [])
        captured = {f['id'] for f in all_frames}
        if seen & captured or len(captured) != len(all_frames):
            raise ValueError('Reused display frame identity')
        seen.update(captured)
        video = {(key,f[key]) for f in o['frames'] for key in ('mediaTime','presentedFrames')
                 if f.get(key) is not None}
        if seen_video & video: raise ValueError('Actual video reused across display commands')
        seen_video.update(video)
        if o['split'] not in ('train', 'holdout'):
            raise ValueError('Invalid display split')
        x.append(np.r_[_linear(drive), 1]); y.append(summary['rgb']); train.append(o['split']=='train')
    x, y, train = np.array(x), np.array(y), np.array(train)
    if train.sum() < 6 or (~train).sum() < 3 or np.linalg.matrix_rank(x[train]) != 4 or np.linalg.cond(x[train]) > 100:
        raise ValueError('Insufficient display holdout/rank coverage')
    penalty = np.diag([1e-8, 1e-8, 1e-8, 1e-10])
    coefficients = np.linalg.solve(x[train].T @ x[train]+penalty, x[train].T @ y[train])
    errors = np.linalg.norm(x[~train] @ coefficients-y[~train], axis=1)/np.sqrt(3)
    if np.max(errors) > .03:
        raise ValueError('Display holdout response validation failed')
    return {'id':str(uuid.uuid4()), 'status':'CameraReferencedDisplayCompensationProfile',
            'domain':'linear-srgb-camera', 'model':'affine-srgb-transfer-surrogate',
            'matrix':coefficients[:3].T.tolist(), 'offset':coefficients[3].tolist(),
            'trainingPatchIds':[o['patchId'] for o in observations if o['split']=='train'],
            'holdoutPatchIds':[o['patchId'] for o in observations if o['split']=='holdout'],
            'absoluteCalibration':False, 'iccProfile':False,
            'validation':{'maxObjective':float(np.max(errors)), 'meanObjective':float(np.mean(errors)),
                          'cardPairing':'observed' if has_cards else 'notProvided'}}


class BoundedMatch:
    """Sequential coordinate trials. Caller authenticates each capture before observe.

    Objective is Euclidean norm in linear camera coordinates, never physical Delta E.
    Stopping without success makes no conclusion about device gamut.
    """

    def __init__(self, target, initial, noise_floor, max_evaluations, tolerance):
        self.target, self.drive = _triples(target), _triples(initial)
        if self.target.shape != (3,) or self.drive.shape != (3,) or np.any(self.drive < 0) or np.any(self.drive > 1):
            raise ValueError('Target and bounded initial drive must be triples')
        if (not np.isfinite(noise_floor) or not np.isfinite(tolerance) or noise_floor <= 0 or tolerance < 0
                or not isinstance(max_evaluations, int) or not 1 <= max_evaluations <= 200):
            raise ValueError('Invalid matching limits')
        self.noise_floor, self.budget, self.tolerance = noise_floor, max_evaluations, tolerance
        self.best, self.objective = self.drive.copy(), float('inf')
        self.iterations, self.step, self.trial = 0, .2, 0
        self.cycle_start, self.terminated = float('inf'), False
        self.confirmations = []

    def observe(self, response):
        if self.terminated:
            raise ValueError('Match already terminated')
        response = _triples(response)
        if response.shape != (3,):
            raise ValueError('Response requires single camera triple')
        objective = float(np.linalg.norm(response-self.target))
        self.iterations += 1
        if self.confirmations and (objective > max(self.tolerance,self.noise_floor)
                or any(np.linalg.norm(response-old) > self.noise_floor for old in self.confirmations)):
            self.confirmations = []
            if np.array_equal(self.best,self.drive):
                self.objective = objective  # Discard the unconfirmed lucky minimum.
        if objective < self.objective:
            self.best, self.objective = self.drive.copy(), objective
        reason = None
        confirming = objective <= max(self.tolerance,self.noise_floor)
        if confirming:
            self.confirmations.append(response.copy())
            self.best = self.drive.copy()
            self.objective = max(float(np.linalg.norm(r-self.target)) for r in self.confirmations)
            if len(self.confirmations) >= 3:
                reason = ('tolerance' if self.tolerance >= self.noise_floor and self.objective <= self.tolerance
                          else 'noise-floor')
        if reason is None and self.iterations >= self.budget: reason = 'evaluation-budget'
        if self.iterations == 1:
            self.cycle_start = self.objective
        while reason is None and not confirming:
            if self.trial >= 6:
                if self.cycle_start-self.objective <= self.noise_floor:
                    self.step *= .5
                self.cycle_start = self.objective
                self.trial = 0
                if self.step <= self.noise_floor:
                    reason = 'noise-floor'
                    break
            axis, sign = self.trial // 2, 1 if self.trial % 2 == 0 else -1
            self.trial += 1
            candidate = self.best.copy()
            candidate[axis] = np.clip(candidate[axis]+sign*self.step, 0, 1)
            if not np.array_equal(candidate, self.best):
                self.drive = candidate
                break
        self.terminated = reason is not None
        return {'nextDrive':None if reason else self.drive.tolist(), 'bestDrive':self.best.tolist(),
                'objectiveValue':self.objective, 'iterations':self.iterations,
                'status':('complete' if reason=='tolerance' else 'stopped') if reason else 'running',
                'terminationReason':reason}


def _polygon_mask(shape, polygon):
    points = np.asarray(polygon, dtype=float)
    if (points.ndim != 2 or points.shape[1] != 2 or not 3 <= len(points) <= 128
            or not np.all(np.isfinite(points)) or np.any(points < 0) or np.any(points > 1)):
        raise ValueError('Polygon requires normalized finite [0,1] coordinates')
    h, w = shape[:2]
    x = (np.arange(w)+.5)/w
    y = (np.arange(h)+.5)[:, None]/h
    mask = np.zeros((h,w), dtype=bool)
    for i in range(len(points)):
        ax, ay = points[i-1]; bx, by = points[i]
        if ay != by:
            mask ^= ((ay > y) != (by > y)) & (x < (bx-ax)*(y-ay)/(by-ay)+ax)
    return mask


def extract_region(rgb, region):
    rgb = _triples(rgb)
    if rgb.ndim != 3:
        raise ValueError('Region requires image HxWx3')
    mask = _polygon_mask(rgb.shape, region['polygon'])
    total = int(mask.sum())
    for exclusion in region.get('exclusions', []):
        mask &= ~_polygon_mask(rgb.shape, exclusion)
    pixels = rgb[mask]
    warnings = []
    # Canonical P3 conversions can legitimately exceed sRGB: not source clipping.
    clipped = int(np.count_nonzero(np.any(((pixels >= 0) & (pixels <= 1/255))
                  | ((pixels >= 254/255) & (pixels <= 1)),axis=1)))
    clipped_rate = clipped/len(pixels) if len(pixels) else 0.
    if clipped_rate > .02: warnings.append('clipped-pixels')
    if len(pixels) < 64: warnings.append('insufficient-pixels')
    excluded = 1-len(pixels)/total if total else 1.
    if excluded > .5: warnings.append('excessive-exclusions')
    if len(pixels):
        linear = _linear(pixels)
        center = np.median(linear, axis=0)
        spread = float(np.percentile(np.linalg.norm(linear-center, axis=1), 90))
        if spread > .15: warnings.append('pattern-or-nonuniform-region')
    else:
        center, spread = None, 0.
    components = []
    patterned = region.get('mode') == 'patterned'
    if patterned and len(pixels):
        warnings.append('patterned-requires-operator-review')
        selected = linear[::max(1,int(np.ceil(len(linear)/8192)))]
        lab = xyz_to_lab(selected @ MATRICES['srgb'].T)
        centers = [lab[np.argmin(lab[:,0])]]
        for _ in range(5):
            distance = np.min(np.linalg.norm(lab[:,None,:]-np.array(centers)[None,:,:],axis=2),axis=1)
            farthest = int(np.argmax(distance))
            if distance[farthest] < 12: break
            centers.append(lab[farthest])
        centers = np.array(centers)
        for _ in range(12):
            labels = np.argmin(np.linalg.norm(lab[:,None,:]-centers[None,:,:],axis=2),axis=1)
            updated = np.array([np.median(lab[labels==i],axis=0) if np.any(labels==i) else c
                                for i,c in enumerate(centers)])
            if np.allclose(updated,centers,atol=.01): break
            centers = updated
        for i in range(len(centers)):
            fraction = float(np.mean(labels==i))
            if fraction < .02: continue
            representative = np.median(selected[labels==i],axis=0)
            components.append({'id':f'component-{len(components)+1}', 'fraction':fraction,
                               'rgb':representative.tolist(),
                               'catalogPreview':catalog_color(representative @ MATRICES['srgb'].T),
                               'physicallyVerified':False, 'operatorConfirmed':False})
    return {'rgb':center.tolist() if center is not None else None,
            'components':components,
            'quality':{'status':'rejected' if warnings else 'accepted', 'warnings':warnings,
                       'validPixels':len(pixels), 'excludedRate':excluded, 'blockSpread':spread,
                        'uniqueFrames':1, 'validBlocks':0, 'temporalStd':None,
                        'clippedPixels':clipped, 'clippedRate':clipped_rate,
                       'domain':'linear-srgb-camera', 'replay':True, 'physicallyVerified':False,
                       'representativeStatus':'operatorReviewRequired' if patterned else 'estimated',
                       'components':components, 'sharpnessStatus':'notAssessed'}}


def suggest_bands(rgb, polygon, orientation):
    rgb = _triples(rgb)
    if rgb.ndim != 3 or orientation not in ('horizontal', 'vertical'):
        raise ValueError('Invalid image or band orientation')
    mask = _polygon_mask(rgb.shape, polygon)
    # Small deterministic downsample limits cost; no merge based on color names.
    stride = max(1, int(max(rgb.shape[:2])/1200))
    image, selected = rgb[::stride,::stride], mask[::stride,::stride]
    if orientation == 'vertical':
        image, selected = image.transpose(1,0,2), selected.T
    rows = np.flatnonzero(np.any(selected, axis=1))
    if not len(rows): return []
    start, end = rows[0], rows[-1]+1
    signal = np.array([np.median(image[i][selected[i]], axis=0) if np.any(selected[i])
                       else [np.nan]*3 for i in range(start,end)])
    if np.any(~np.isfinite(signal)): return []
    smooth = median_filter(signal, size=(3,1))
    gradient = np.linalg.norm(np.diff(smooth, axis=0), axis=1)
    # Heuristic proposals only; textiles, folds and patterns require operator editing.
    peaks, _ = find_peaks(np.r_[0,gradient,0], height=.025, distance=max(3,len(signal)//40))
    boundaries = [start] + [start+int(p) for p in peaks if 2 < p < len(signal)-2] + [end]
    if len(boundaries)>33: boundaries = [start,end]
    points = np.asarray(polygon)
    edges = np.roll(points,-1,axis=0)-points
    cross = edges[:,0]*np.roll(edges,-1,axis=0)[:,1]-edges[:,1]*np.roll(edges,-1,axis=0)[:,0]
    if np.any(cross > 1e-12) and np.any(cross < -1e-12):
        return []  # Concave/disconnected strip intersection needs manual annotation.
    proposals = []
    for i, (a,b) in enumerate(zip(boundaries[:-1],boundaries[1:])):
        lo, hi = a/image.shape[0], b/image.shape[0]
        poly = points.tolist()
        axis = 1 if orientation=='horizontal' else 0
        for boundary, sign in ((lo,1),(hi,-1)):
            clipped = []
            for j, p in enumerate(poly):
                q = poly[j-1]
                inside_p, inside_q = sign*(p[axis]-boundary)>=0, sign*(q[axis]-boundary)>=0
                if inside_p != inside_q:
                    fraction = (boundary-q[axis])/(p[axis]-q[axis])
                    clipped.append((np.array(q)+fraction*(np.array(p)-q)).tolist())
                if inside_p: clipped.append(p)
            poly = clipped
            if not poly: break
        if len(poly)<3: continue
        first = min(range(len(poly)), key=lambda j:(poly[j][axis],poly[j][1-axis]))
        poly = poly[first:]+poly[:first]
        proposals.append({'id':f'band-{i+1}', 'label':f'Band {i+1}', 'order':i, 'mode':'bands',
                          'polygon':poly, 'exclusions':[], 'background':None, 'layers':None,
                          'direction':orientation, 'operatorConfirmed':False})
    return proposals
