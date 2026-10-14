"""Session-relative camera observations of actual display drives, never ICC/XYZ.

The nominal canvas transfer is a coordinate convention. An unknown camera ISP
and an unknown physical card cannot establish absolute color or firmware locks.
"""
import uuid

import numpy as np
from scipy.optimize import least_squares
from scipy.spatial import Delaunay

from .models import Frame


def response_steps():
    """Nine full-rank train commands followed by two untouched holdout commands."""
    train = [[v] * 3 for v in (.5, .08, .2, .6, .8)]
    train += [[.6, .08, .08], [.08, .6, .08], [.08, .08, .6], [.55, .35, .65]]
    holdout = [[.38, .42, .46], [.5, .44, .4]]
    return [{'drive': drive, 'phase': 'train'} for drive in train] + [
        {'drive': drive, 'phase': 'holdout'} for drive in holdout]


def geometry(frame):
    roi = np.asarray(frame['roi'], dtype=float)
    # Conservatively reject even bounding-box overlap between co-captured ROIs.
    return (float(roi[:, 0].min()), float(roi[:, 1].min()),
            float(roi[:, 0].max()), float(roi[:, 1].max()))


def summarize_relative(frames):
    """Robust native ROI stats with an explicit, limited zero-media-clock branch."""
    frames = [Frame.model_validate(frame).model_dump() for frame in frames]
    if len(frames) < 10:
        raise ValueError('response_minimum_ten_frames_required')
    first = frames[0]
    required = ('presentedFrames', 'mediaTime', 'width', 'height', 'roi', 'regionId', 'exclusions')
    if any(any(f[k] is None for k in required) or f['source'] != 'videoCanvas' for f in frames):
        raise ValueError('response_native_video_roi_required')
    signature = tuple(first[k] for k in ('width', 'height', 'roi', 'regionId', 'exclusions', 'colorSpace', 'settingsFingerprint'))
    if any(tuple(f[k] for k in ('width', 'height', 'roi', 'regionId', 'exclusions', 'colorSpace', 'settingsFingerprint')) != signature for f in frames):
        raise ValueError('response_native_geometry_or_settings_changed')
    roi = np.asarray(first['roi'])
    area = abs(float(np.dot(roi[:, 0], np.roll(roi[:, 1], 1)) - np.dot(roi[:, 1], np.roll(roi[:, 0], 1)))) / 2
    x0, y0, x1, y1 = geometry(first)
    native_area = area * first['width'] * first['height']
    if native_area < 16 or (x1 - x0) * first['width'] < 4 or (y1 - y0) * first['height'] < 4:
        raise ValueError('response_nonempty_native_roi_required')
    native_polygon=roi*np.array([first['width'],first['height']])
    perimeter=float(np.linalg.norm(native_polygon-np.roll(native_polygon,1,axis=0),axis=1).sum())
    # Raster centers may cover more cells than continuous polygon area. Bound the
    # boundary-cell allowance instead of rejecting legitimate fractional ROIs.
    raster_bound=min(np.ceil(native_area+perimeter/np.sqrt(2)+np.pi/2),
                     (np.ceil(x1*first['width'])-np.floor(x0*first['width']))*
                     (np.ceil(y1*first['height'])-np.floor(y0*first['height'])))
    if any(f['pixelCount'] > raster_bound for f in frames):
        raise ValueError('response_pixel_count_exceeds_native_roi')
    times = np.array([f['capturedAt'] for f in frames])
    presented = np.array([f['presentedFrames'] for f in frames])
    media = np.array([f['mediaTime'] for f in frames])
    zero_clock = bool(np.all(media == 0))
    if (len({f['id'] for f in frames}) != len(frames) or np.any(np.diff(presented) <= 0)
            or np.any(np.diff(times) <= 0) or times[-1] - times[0] < 1000
            or (not zero_clock and np.any(np.diff(media) <= 0))):
        raise ValueError('response_unique_callback_frames_over_one_second_required')
    centers, spreads, within, clipped, sampled, excluded, counts = [], [], [], 0, 0, 0, 0
    for frame in frames:
        pixels = np.asarray(frame['pixels'])
        blocks = np.asarray(frame['blockIds'])
        linear = np.where(pixels <= .04045, pixels / 12.92, ((pixels + .055) / 1.055) ** 2.4)
        # Keep the recognized native canvas channels; do not relabel camera RGB as XYZ.
        medians = [np.median(linear[blocks == block], axis=0) for block in np.unique(blocks)
                   if np.count_nonzero(blocks == block) >= 4]
        if len(medians) < 4:
            raise ValueError('response_four_spatial_blocks_required')
        center = np.median(medians, axis=0)
        centers.append(center)
        spreads.append(float(np.max(np.linalg.norm(np.asarray(medians) - center, axis=1))))
        for block in np.unique(blocks):
            data = linear[blocks == block]
            within.extend(np.linalg.norm(data - np.median(data, axis=0), axis=1))
        clipped += int(np.count_nonzero(np.any((pixels <= 1 / 255) | (pixels >= 254 / 255), axis=1)))
        sampled += len(pixels)
        excluded += frame['excludedCount']
        counts += frame['pixelCount']
    temporal = float(np.max(np.std(centers, axis=0)))
    noise = float(np.max(np.median(np.abs(np.asarray(centers) - np.median(centers, axis=0)), axis=0))) * 1.4826
    if clipped / sampled > .02 or temporal > .01 or max(spreads) > .08 or np.percentile(within, 90) > .08 or excluded / counts > .5:
        raise ValueError('response_capture_clipped_or_unstable')
    return {'rgb': np.median(centers, axis=0).tolist(), 'signature': signature,
            'quality': {'status': 'accepted', 'uniqueFrames': len(frames), 'spanMs': float(times[-1] - times[0]),
                        'temporalStd': temporal, 'noiseFloor': noise, 'blockSpread': max(spreads),
                        'clippedRate': clipped / sampled, 'rawMediaClockState': 'unavailable' if zero_clock else 'reported',
                        'timeSource': 'reportedCallbackCapturedAt', 'physicalTimingVerified': False,
                        'domain': 'nominal-transfer-linear-native-cameraRGB', 'referenceWhite': 'D65Nominal',
                        'nativeCanvasColorSpace': first['colorSpace'], 'encoding': 'encoded',
                        'colorimetricObserver': None, 'sharpnessStatus': 'notAssessed'},
            'provenance': [{k: v for k, v in f.items() if k not in ('pixels', 'blockIds', 'markerPixels')} for f in frames]}


def paired_relative(frames, card_frames, *, fingerprint, width, height, signatures=None):
    screen, card = summarize_relative(frames), summarize_relative(card_frames)
    if len(frames) != len(card_frames):
        raise ValueError('response_co_captured_card_required')
    for a, b in zip(frames, card_frames):
        identity = ('presentedFrames', 'mediaTime', 'width', 'height', 'colorSpace', 'settingsFingerprint', 'capturedAt')
        if any(a[k] != b[k] for k in identity):
            raise ValueError('response_full_identity_cocapture_required')
        if a['id'] == b['id']:
            raise ValueError('response_distinct_roi_frame_ids_required')
        x, y = geometry(a), geometry(b)
        if not (x[2] <= y[0] or y[2] <= x[0] or x[3] <= y[1] or y[3] <= x[1]):
            raise ValueError('response_disjoint_screen_card_required')
    if any(f['settingsFingerprint'] != fingerprint or (f['width'], f['height']) != (width, height) for f in frames + card_frames):
        raise ValueError('response_dimensions_or_fingerprint_changed')
    if signatures and (screen['signature'], card['signature']) != signatures:
        raise ValueError('response_native_roi_changed')
    return screen, card


def witness_drift(baseline, current):
    before, after = np.asarray(baseline['rgb']), np.asarray(current['rgb'])
    if np.min(before) < .008 or np.min(after) < .008:
        raise ValueError('response_card_too_dark_for_relative_ratios')
    if any(np.ptp(rgb / np.mean(rgb)) > .45 for rgb in (before, after)):
        raise ValueError('response_neutral_card_chromaticity_ambiguous')
    ratios = after / before
    maximum = float(np.max(np.abs(ratios - 1)))
    noise = max(baseline['quality']['noiseFloor'], current['quality']['noiseFloor'])
    limit = min(.03, max(.015, 6 * noise / float(np.min(before))))
    report = {'relativeChannelRatios': ratios.tolist(), 'maxRelativeDrift': maximum,
              'maximumAllowedRelativeDrift': limit, 'measuredNoiseFloor': noise,
              'firmwareLocksVerified': False}
    if maximum > limit:
        raise ValueError('response_neutral_witness_drift')
    return report


def _predict(parameters, drive):
    return np.asarray(drive) ** parameters[12:15] @ parameters[:9].reshape(3, 3).T + parameters[9:12]


def characterize(observations):
    train = [o for o in observations if o['phase'] == 'train']
    holdout = [o for o in observations if o['phase'] == 'holdout']
    if len(train) < 9 or len(holdout) < 2:
        raise ValueError('response_nine_train_two_holdout_required')
    drives = np.asarray([o['drive'] for o in train], dtype=float)
    observed = np.asarray([o['rgb'] for o in train], dtype=float)
    if drives.shape != (len(train), 3) or observed.shape != drives.shape or not np.all(np.isfinite([drives, observed])):
        raise ValueError('response_finite_triples_required')
    rank = int(np.linalg.matrix_rank(drives - drives.mean(axis=0)))
    if rank != 3 or len(np.unique(drives, axis=0)) < 9 or np.any(drives < .08) or np.any(drives > .8):
        raise ValueError('response_full_rank_actual_drive_coverage_required')
    gray = np.ptp(drives, axis=1) < 1e-9
    ordered = np.argsort(drives[gray, 0])
    gray_response = observed[gray][ordered]
    if len(gray_response) < 4 or np.any(np.diff(gray_response, axis=0) <= .001):
        raise ValueError('response_measured_gray_ramp_not_monotonic')
    initial = np.r_[np.eye(3).ravel(), [.01] * 3, [2.2] * 3]
    # A separable monotonic power response plus regularized cross-channel matrix
    # captures gamma/offset/crosstalk without pretending a camera calibration.
    def residual(parameters):
        regularized = np.r_[parameters[:9] - np.eye(3).ravel(), parameters[12:15] - 2.2]
        return np.r_[(_predict(parameters, drives) - observed).ravel(), 1e-4 * regularized]
    lower = np.r_[[0.] * 9, [-.2] * 3, [.3] * 3]
    upper = np.r_[[2.] * 9, [.4] * 3, [4.] * 3]
    fit = least_squares(residual, initial, bounds=(lower, upper), max_nfev=1500, ftol=1e-12, xtol=1e-12, gtol=1e-12)
    data_jacobian = fit.jac[: observed.size]
    parameter_rank = int(np.linalg.matrix_rank(data_jacobian))
    parameter_condition = float(np.linalg.cond(data_jacobian))
    if (not fit.success or np.linalg.cond(fit.x[:9].reshape(3, 3)) > 100
            or parameter_rank != 15 or parameter_condition > 1000):
        raise ValueError('response_ill_conditioned_model')
    errors = np.linalg.norm(_predict(fit.x, drives) - observed, axis=1)
    hold_drives = np.asarray([o['drive'] for o in holdout])
    hold_rgb = np.asarray([o['rgb'] for o in holdout])
    if hold_rgb.shape != hold_drives.shape or hold_drives.shape != (len(holdout), 3) or not np.all(np.isfinite([hold_rgb, hold_drives])):
        raise ValueError('response_finite_holdout_required')
    if (len(np.unique(hold_drives, axis=0)) < 2 or any(np.any(np.all(drives == drive, axis=1)) for drive in hold_drives)
            or np.any(Delaunay(drives).find_simplex(hold_drives, tol=1e-8) < 0)):
        raise ValueError('response_independent_supported_holdout_drives_required')
    hold_errors = np.linalg.norm(_predict(fit.x, hold_drives) - hold_rgb, axis=1)
    nominal = np.where(hold_drives <= .04045, hold_drives / 12.92, ((hold_drives + .055) / 1.055) ** 2.4)
    before_errors = np.linalg.norm(nominal - hold_rgb, axis=1)
    if max(float(errors.max()), float(hold_errors.max())) > .025:
        raise ValueError('response_normalized_rgb_validation_failed')
    def statistics(values):
        return {'mean': float(np.mean(values)), 'median': float(np.median(values)),
                'p95': float(np.percentile(values, 95)), 'max': float(np.max(values))}
    return {'id': str(uuid.uuid4()), 'status': 'cameraReferencedExperimental', 'validProfile': True,
            'model': 'regularized-channel-power-cross-talk-affine', 'parameters': fit.x.tolist(),
            'trainingDrives': drives.tolist(), 'trainingPatchIds': [o['patchId'] for o in train],
            'holdoutPatchIds': [o['patchId'] for o in holdout],
            'blackAmbientOffset': fit.x[9:12].tolist(),
            'nearBlackObservedRgb': train[int(np.argmin(np.max(drives, axis=1)))]['rgb'], 'trueBlackMeasured': False,
            'referenceValuesKnown': False, 'iccProfile': False, 'absoluteCalibration': False,
            'fullCameraCalibration': False, 'physicalAccuracyVerified': False,
            'limited': True, 'physicalTimingVerified': False,
            'independentValidationStatus': 'notTested', 'colorimetricObserver': None,
            'referenceWhite': 'D65Nominal', 'domain': 'nominal-transfer-linear-native-cameraRGB',
            'transferConvention': 'nominal-srgb-EOTF-native-canvas-channels',
            'validation': {'rank': rank, 'parameterRank': parameter_rank, 'parameterConditionNumber': parameter_condition,
                           'acceptancePolicy': {'metric': 'cameraRgbEuclidean', 'normalization': 'unitChannelCoordinates',
                                                'maxResidual': .025, 'meaning': 'heuristicAbsoluteNormalizedCameraRGB',
                                                'relativePercentAccuracy': None, 'physicalAccuracy': None},
                           'regularization': 1e-8, 'metric': 'normalizedCameraRgbEuclidean',
                           'train': statistics(errors), 'holdout': statistics(hold_errors),
                           'holdoutBeforeNominalUncharacterized': statistics(before_errors),
                           'holdoutAfterCharacterized': statistics(hold_errors),
                           'perPatch': [{'patchId': o['patchId'], 'residual': float(e),
                                         'beforeNominalResidual': float(b)} for o, e, b in zip(holdout, hold_errors, before_errors)],
                           'independentInstrumentValidation': False},
            'limitations': ['unknownCameraISP', 'noVerifiedFirmwareLock', 'unknownCardReflectance',
                            'relativeCameraAppearanceOnly', 'notICCOrAbsoluteCalibration', 'notMaterialTrueColor']}


def invert_response(profile, target):
    if not profile or not profile.get('validProfile') or profile.get('status') != 'cameraReferencedExperimental':
        raise ValueError('response_valid_profile_required')
    target = np.asarray(target, dtype=float)
    if target.shape != (3,) or not np.all(np.isfinite(target)):
        raise ValueError('response_finite_target_required')
    parameters = np.asarray(profile['parameters'])
    if parameters.shape != (15,) or not np.all(np.isfinite(parameters)):
        raise ValueError('response_invalid_model')
    fit = least_squares(lambda drive: _predict(parameters, drive) - target, [.4] * 3, bounds=(0., 1.),
                        ftol=1e-12, xtol=1e-12, gtol=1e-12)
    drive = fit.x
    predicted = _predict(parameters, drive)
    error = float(np.linalg.norm(predicted - target))
    # Interpolation only. A bounded optimizer alone does not establish support.
    supported = bool(fit.success and Delaunay(profile['trainingDrives']).find_simplex(drive, tol=1e-8) >= 0 and error <= .025)
    return {'drive': drive.tolist() if supported else None, 'predictedRgb': predicted.tolist(),
            'predictedResidual': error, 'outOfSupport': not supported,
            'extrapolation': not supported, 'clipped': bool(np.any(drive < 1e-6) or np.any(drive > 1 - 1e-6)),
            'physicalGamutConclusion': None, 'metric': 'normalizedCameraRgbEuclidean',
            'status': 'cameraReferencedExperimental' if supported else 'outOfSupport',
            'independentValidationStatus': 'notTested', 'physicalAccuracyVerified': False}


def fit_display_response(observations):
    """Return an explicit invalid profile on rejected evidence, never usable coefficients."""
    try:
        return characterize(observations)
    except (ValueError, TypeError, KeyError) as exc:
        return {'status': 'invalid', 'validProfile': False, 'errorCode': str(exc),
                'referenceValuesKnown': False, 'physicalAccuracyVerified': False,
                'independentValidationStatus': 'notTested', 'validation': {'status': 'rejected'}}


def compensate_preview(target_camera_linear_rgb, profile):
    """Only compensate supported camera appearances using a valid measured response."""
    if not profile or not profile.get('validProfile') or profile.get('status') != 'cameraReferencedExperimental':
        return {'drive': None, 'status': 'notCompensated', 'predictedResidual': None,
                'warnings': ['response_valid_profile_required'], 'outOfSupport': True}
    try:
        result = invert_response(profile, target_camera_linear_rgb)
    except (ValueError, TypeError, KeyError):
        return {'drive': None, 'status': 'notCompensated', 'predictedResidual': None,
                'warnings': ['response_invalid_model'], 'outOfSupport': True}
    return {**result, 'warnings': ['relativeCameraAppearanceOnly'] if result['drive'] is not None else ['response_out_of_support']}
