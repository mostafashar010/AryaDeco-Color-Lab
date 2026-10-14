import importlib
from pathlib import Path
import io
import struct
import hashlib

from PIL import Image, ImageCms

import numpy as np
import pytest


def engine():
    return importlib.import_module('colorlab.engine')


def test_rgb_xyz_lab_and_bradford_roundtrip():
    e = engine()
    white = e.rgb_to_xyz([1, 1, 1])
    np.testing.assert_allclose(white, [0.950455927, 1, 1.089057751], atol=1e-8)
    np.testing.assert_allclose(e.xyz_to_lab(white), [100, 0, 0], atol=1e-8)
    colors = e.rgb_to_xyz([[0.1, 0.4, 0.8], [1, 0, 0]])
    np.testing.assert_allclose(e.lab_to_xyz(e.xyz_to_lab(colors)), colors, atol=1e-12)
    d50 = e.adapt_xyz(white)
    # Explicitly request D65 -> D50, not the default D50 -> D65.
    d50 = e.adapt_xyz(white, source='D65', target='D50')
    np.testing.assert_allclose(d50, [0.964295676, 1, 0.825104603], atol=1e-8)
    np.testing.assert_allclose(e.adapt_xyz(d50), white, atol=1e-12)
    assert e.catalog_color(e.rgb_to_xyz([1, 0, 0]))['hex'] == '#FF0000'
    assert e.catalog_color(e.rgb_to_xyz([1, 0, 0], 'display-p3'))['outOfGamut']


@pytest.mark.parametrize('value', [[float('nan'), 0, 0], [1, 2], [[1, 2, 3, 4]]])
def test_color_input_rejects_nonfinite_and_wrong_shape(value):
    with pytest.raises(ValueError):
        engine().rgb_to_xyz(value)


def test_all_published_sharma_vectors():
    # Sharma/Wu/Dalal supplementary data, Rochester ciede2000testdata.txt.
    data = np.loadtxt(Path(__file__).parent / 'fixtures/sharma.txt')
    assert len(data) == 34
    np.testing.assert_allclose(engine().delta_e00(data[:, :3], data[:, 3:6]), data[:, 6], atol=5e-5)
    np.testing.assert_allclose(engine().delta_e00(data[:, 3:6], data[:, :3]), data[:, 6], atol=5e-5)


def image_bytes(rgb, icc=None):
    stream = io.BytesIO()
    Image.fromarray(np.asarray(rgb, dtype=np.uint8)).save(stream, format='PNG', icc_profile=icc)
    return stream.getvalue()


def matrix_profile(space):
    # Actual ICC XYZ/TRC tags, not a description-based color-space guess.
    profile = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes())
    count = struct.unpack_from('>I', profile, 128)[0]
    matrix = engine().adapt_xyz(engine().MATRICES[space].T, source='D65', target='D50').T
    for i in range(count):
        signature, offset, _ = struct.unpack_from('>4sII', profile, 132 + 12*i)
        if signature in (b'rXYZ', b'gXYZ', b'bXYZ'):
            channel = (b'rXYZ', b'gXYZ', b'bXYZ').index(signature)
            struct.pack_into('>iii', profile, offset+8, *(int(round(v*65536)) for v in matrix[:, channel]))
    return bytes(profile)


def test_icc_matrix_preserves_p3_gamut_and_is_applied_once():
    e = engine()
    data = image_bytes([[[255, 0, 0]]], matrix_profile('display-p3'))
    decoded = e.decode_image(data)
    assert decoded['metadata']['iccApplied'] is True
    np.testing.assert_allclose(e.rgb_to_xyz(decoded['rgb'])[0, 0], e.rgb_to_xyz([1, 0, 0], 'display-p3'), atol=5e-5)
    assert decoded['rgb'][0, 0, 0] > 1
    assert decoded['rgb'][0, 0, 1] < 0
    assert e.catalog_color(e.rgb_to_xyz(decoded['rgb'])[0, 0])['outOfGamut']
    with pytest.raises(ValueError, match='already'):
        e.decode_image(data, assumed_space='canonical-srgb')


def test_icc_same_color_in_srgb_and_p3_and_unknown_profile():
    e = engine()
    xyz = e.rgb_to_xyz([.3, .5, .7])
    p3 = e._encoded(xyz @ np.linalg.inv(e.MATRICES['display-p3']).T)
    a = e.decode_image(image_bytes([[[77, 128, 179]]], matrix_profile('srgb')))
    b = e.decode_image(image_bytes(np.round(p3*255).astype(np.uint8)[None, None], matrix_profile('display-p3')))
    assert e.delta_e00(e.xyz_to_lab(e.rgb_to_xyz(a['rgb'])), e.xyz_to_lab(e.rgb_to_xyz(b['rgb']))).item() < .5
    with pytest.raises(ValueError, match='ICC'):
        e.decode_image(image_bytes([[[10, 20, 30]]], b'not an ICC'))
    missing = e.decode_image(image_bytes([[[10, 20, 30]]]))
    assert missing['metadata']['assumed'] and missing['metadata']['exploratory']


def frames(rgb=(.4, .5, .6), prefix='frame'):
    return [{'id': f'{prefix}-{i}', 'capturedAt': i*120., 'pixels': [list(rgb)]*32,
             'colorSpace': 'srgb', 'encoding': 'encoded', 'blockIds': [j//8 for j in range(32)],
             'pixelCount': 32, 'excludedCount': 0, 'source': 'videoCanvas',
             'settingsFingerprint': 'locked', 'markerSequence': None} for i in range(10)]


def test_multiblock_multiframe_robust_summary():
    e = engine()
    f = frames()
    f[0]['pixels'][0] = [.65, .65, .65]
    summary = e.summarize_frames(f)
    assert summary['quality']['status'] == 'accepted'
    assert summary['quality']['validBlocks'] == 4
    np.testing.assert_allclose(summary['rgb'], e._linear([.4, .5, .6]), atol=1e-12)


@pytest.mark.parametrize('reason', ['duplicate', 'short', 'stale', 'blocks', 'clip', 'excluded', 'fingerprint', 'temporal'])
def test_capture_rejects_untrustworthy_samples(reason):
    f = frames()
    if reason == 'duplicate':
        f[1]['id'] = f[0]['id']
    elif reason == 'short':
        f = f[:9]
    elif reason == 'stale':
        f[3]['capturedAt'] = f[2]['capturedAt']
    elif reason == 'blocks':
        for x in f: x['blockIds'] = [0]*32
    elif reason == 'clip':
        f = frames((0, .5, 1))
    elif reason == 'excluded':
        for x in f:
            x['excludedCount'] = 100
            x['pixelCount'] = 132
    elif reason == 'fingerprint':
        f[-1]['settingsFingerprint'] = 'changed'
    else:
        f[-1]['pixels'] = [[.8, .8, .8]]*32
    assert engine().summarize_frames(f)['quality']['status'] == 'rejected'


def camera_fixture():
    e = engine()
    rgb = np.array([[.2,.2,.2], [.7,.25,.3], [.3,.7,.3], [.3,.3,.7], [.7,.6,.2], [.2,.6,.7],
                    [.4,.4,.4], [.6,.3,.6], [.5,.7,.25]])
    target = {'id':'card', 'label':'synthetic', 'source':'synthetic test transform', 'version':'1',
              'valueType':'XYZ', 'referenceWhite':'D50', 'observer':'2', 'xyzScale':1,
              'validity':'verified', 'patches':[]}
    obs = []
    for i, c in enumerate(rgb):
        xyz = e.adapt_xyz(e.rgb_to_xyz(c), source='D65', target='D50')
        target['patches'].append({'id':str(i), 'values':xyz.tolist(), 'split':'train' if i<6 else 'holdout',
                                  'neutral':i in (0,6)})
        obs.append({'patchId':str(i), 'frames':frames(c, f'p{i}')})
        x,y = (i%3)/3,(i//3)/3
        for frame in obs[-1]['frames']:
            frame.update(regionId=f'physical-{i}',width=900,height=900,
                         roi=[[x+.02,y+.02],[x+.3,y+.02],[x+.3,y+.3],[x+.02,y+.3]])
    return target, obs


def test_camera_fit_uses_physical_holdout_and_regularized_matrix():
    e = engine()
    target, obs = camera_fixture()
    fit = e.fit_camera(target, obs)
    assert fit['status'] == 'referenced'
    assert set(fit['trainingPatchIds']).isdisjoint(fit['holdoutPatchIds'])
    assert fit['validation']['maxDeltaE00'] < .01
    assert fit['validation']['rank'] == 3
    assert fit['validation']['regularization'] > 0
    np.testing.assert_allclose(e.apply_camera(e._linear([.4,.5,.6]), fit), e.rgb_to_xyz([.4,.5,.6]), atol=1e-6)


@pytest.mark.parametrize('case', ['observer', 'unverified', 'duplicates', 'missing', 'neutral', 'holdout-error'])
def test_camera_fail_closed_reference_coverage(case):
    target, obs = camera_fixture()
    if case == 'observer': target['observer'] = '10'
    if case == 'unverified': target['validity'] = 'unverified'
    if case == 'duplicates': target['patches'][6]['id'] = '0'
    if case == 'missing': obs = obs[:-1]
    if case == 'neutral':
        for p in target['patches']: p['neutral'] = True
    if case == 'holdout-error': target['patches'][-1]['values'] = [.01, .01, .01]
    with pytest.raises(ValueError): engine().fit_camera(target, obs)


def test_exploratory_has_no_camera_matrix():
    e = engine()
    fit = e.fit_camera({'exploratory':True}, [])
    assert fit['status'] == 'exploratory' and fit['matrix'] is None
    with pytest.raises(ValueError): e.apply_camera([.2,.3,.4], fit)


def test_display_response_fit_and_witness_in_camera_domain():
    e = engine()
    drives = [[.15,.15,.15], [.7,.2,.2], [.2,.7,.2], [.2,.2,.7], [.65,.65,.2], [.2,.65,.65],
              [.4,.4,.4], [.6,.3,.6], [.3,.6,.5]]
    observations = [{'drive':d, 'frames':frames(d, f'd{i}'), 'witnessFrames':frames(prefix=f'w{i}'),
                     'split':'train' if i<6 else 'holdout', 'patchId':f'd{i}', 'commandSequence':i+1,
                     'cardPatchId':'neutral-card'} for i,d in enumerate(drives)]
    fit = e.fit_display(observations)
    assert fit['status'] == 'CameraReferencedDisplayCompensationProfile'
    assert fit['domain'] == 'linear-srgb-camera'
    assert fit['validation']['maxObjective'] < .03
    assert not fit['absoluteCalibration']
    assert e.check_witness(frames(), frames(prefix='fresh'))
    assert not e.check_witness(frames(), frames((.7,.5,.6), 'changed'))
    observations[-1]['witnessFrames'] = frames((.7,.5,.6), 'changed')
    with pytest.raises(ValueError, match='witness'): e.fit_display(observations)


def test_bounded_match_coordinate_search_converges():
    e = engine()
    match = e.BoundedMatch([.35,.65,.45], [.5,.5,.5], noise_floor=.001, max_evaluations=80, tolerance=.012)
    drive = np.array([.5,.5,.5])
    for _ in range(80):
        result = match.observe(drive)
        assert np.all(np.array(result['bestDrive']) >= 0) and np.all(np.array(result['bestDrive']) <= 1)
        if result['nextDrive'] is None: break
        drive = np.array(result['nextDrive'])
    assert result['status'] == 'complete'
    assert result['terminationReason'] == 'tolerance'
    assert result['objectiveValue'] <= .012
    with pytest.raises(ValueError, match='terminated'): match.observe(drive)


@pytest.mark.parametrize('case', ['budget', 'noise'])
def test_bounded_match_explicit_stop_not_gamut_claim(case):
    e = engine()
    match = e.BoundedMatch([.8,.8,.8], [.4,.4,.4], noise_floor=.02, max_evaluations=2 if case=='budget' else 80, tolerance=.001)
    result = {}
    for _ in range(80):
        result = match.observe([.4,.4,.4])
        if result['nextDrive'] is None: break
    assert result['terminationReason'] == ('evaluation-budget' if case=='budget' else 'noise-floor')
    assert result['status'] == 'stopped'
    assert 'gamut' not in result['terminationReason']


def test_region_excludes_meter_and_returns_linear_color():
    rgb = np.full((80, 80, 3), .5)
    rgb[:, :20] = .95
    region = {'id':'cloth', 'label':'cloth', 'order':0, 'mode':'solid',
              'polygon':[[0,0],[1,0],[1,1],[0,1]],
              'exclusions':[[[0,0],[.25,0],[.25,1],[0,1]]], 'operatorConfirmed':True}
    result = engine().extract_region(rgb, region)
    assert result['quality']['status'] == 'accepted'
    assert result['quality']['validPixels'] == 4800
    np.testing.assert_allclose(result['rgb'], engine()._linear([.5,.5,.5]))
    assert result['quality']['excludedRate'] == .25
    region['polygon'] = [[-.1,0],[1,0],[1,1]]
    with pytest.raises(ValueError): engine().extract_region(rgb, region)


def test_band_suggestions_keep_near_colors_and_normalized_geometry():
    rgb = np.zeros((120, 60, 3))
    rgb[:40] = [.4,.4,.4]; rgb[40:80] = [.46,.46,.46]; rgb[80:] = [.65,.6,.6]
    polygon = [[0,0],[1,0],[1,1],[0,1]]
    bands = engine().suggest_bands(rgb, polygon, 'horizontal')
    assert len(bands) == 3
    assert all(not b['operatorConfirmed'] for b in bands)
    assert abs(bands[1]['polygon'][0][1]-1/3) < .03
    rotated = engine().suggest_bands(np.rot90(rgb), polygon, 'vertical')
    assert len(rotated) == 3
    resized = engine().suggest_bands(np.repeat(np.repeat(rgb,2,0),2,1), polygon, 'horizontal')
    assert len(resized) == 3
    assert abs(resized[1]['polygon'][0][1]-bands[1]['polygon'][0][1]) < .02


@pytest.mark.parametrize('name,sha,size,space', [
    ('01-striped-sheer.jpg','ff8ba695559f82d5bf5ec5f9c714488444e4855d8f2a02291f39ab8a6d24d97d',(1536,1150),'srgb'),
    ('02-swatch-bands.jpg','ae19fc687b927e4af8362add615a6667a14ff5106a628189937811318b92c2e2',(864,1536),'display-p3')])
def test_immutable_real_original_geometry_icc_not_physical_color(name, sha, size, space):
    data = (Path(__file__).parents[1]/'references'/name).read_bytes()
    assert hashlib.sha256(data).hexdigest() == sha
    result = engine().decode_image(data)
    assert result['rgb'].shape == (size[1],size[0],3)
    assert result['metadata']['sourceColorSpace'] == space
    assert result['metadata']['iccDescription']
    assert result['metadata']['physicallyVerified'] is False


def test_camera_rejects_cross_patch_settings_change():
    target, observations = camera_fixture()
    for f in observations[-1]['frames']: f['settingsFingerprint'] = 'new-exposure'
    with pytest.raises(ValueError, match='settings'): engine().fit_camera(target, observations)


def test_display_rejects_unstable_first_witness_without_good_witness_baseline():
    observations = [{'drive':[.1+i*.05]*3, 'frames':frames(prefix=f'd{i}'),
                     'witnessFrames':frames(prefix=f'w{i}'), 'split':'train' if i<6 else 'holdout',
                     'patchId':f'd{i}', 'commandSequence':i+1} for i in range(9)]
    observations[0]['witnessFrames'] = frames((0,0,0), 'black')
    with pytest.raises(ValueError, match='witness'): engine().fit_display(observations)


def test_degenerate_polygon_has_no_sampling_area():
    region = {'polygon':[[.1,.1],[.1,.1],[.1,.1]], 'exclusions':[]}
    assert engine().extract_region(np.ones((20,20,3))*.4, region)['quality']['status'] == 'rejected'


def test_suggestions_do_not_expand_selected_polygon_into_background():
    image = np.full((120,120,3), .5)
    polygon = [[.5,.1],[.9,.9],[.1,.9]]
    bands = engine().suggest_bands(image, polygon, 'horizontal')
    original = engine()._polygon_mask(image.shape, polygon)
    for band in bands:
        proposed = engine()._polygon_mask(image.shape, band['polygon'])
        assert not np.any(proposed & ~original)


def test_unsupported_lut_profile_rejected_not_guessed_from_description():
    profile = bytearray(matrix_profile('srgb'))
    count = struct.unpack_from('>I', profile, 128)[0]
    for i in range(count):
        signature, _, _ = struct.unpack_from('>4sII', profile, 132+12*i)
        if signature == b'cprt':
            struct.pack_into('>4s', profile, 132+12*i, b'A2B0')
            break
    with pytest.raises(ValueError, match='LUT'): engine().decode_image(image_bytes([[[50,100,150]]], bytes(profile)))


def test_sampler_rejects_repeated_actual_video_frame_with_different_client_ids():
    captured = frames()
    for f in captured:
        f['presentedFrames'] = 42
        f['mediaTime'] = 12.0
    result = engine().summarize_frames(captured)
    assert result['quality']['status'] == 'rejected'
    assert 'duplicate-video-frame' in result['quality']['warnings']


def test_summary_does_not_invent_blur_assessment():
    assert engine().summarize_frames(frames())['quality']['sharpnessStatus'] == 'notAssessed'


def test_display_rejects_missing_card_pairing_and_unstable_actual_card():
    drives = [[.15,.15,.15], [.7,.2,.2], [.2,.7,.2], [.2,.2,.7], [.65,.65,.2], [.2,.65,.65],
              [.4,.4,.4], [.6,.3,.6], [.3,.6,.5]]
    obs = [{'drive':d, 'frames':frames(d, f'd{i}'), 'witnessFrames':frames(prefix=f'w{i}'),
            'cardFrames':frames((.3,.3,.3), f'c{i}'), 'cardPatchId':'same-card',
            'split':'train' if i<6 else 'holdout', 'patchId':f'd{i}', 'commandSequence':i+1}
           for i,d in enumerate(drives)]
    assert engine().fit_display(obs)['validation']['cardPairing'] == 'observed'
    obs[-1]['cardFrames'] = frames((.5,.5,.5), 'changed-card')
    with pytest.raises(ValueError, match='card'): engine().fit_display(obs)


@pytest.mark.parametrize('function,args', [('xyz_to_lab',([.1,.2,.3],)),('lab_to_xyz',([50,0,0],)),
                                          ('adapt_xyz',([.1,.2,.3],))])
def test_unknown_reference_white_is_explicit_rejection(function,args):
    kwargs = {'source':'D55'} if function=='adapt_xyz' else {'white':'D55'}
    with pytest.raises(ValueError, match='white'): getattr(engine(),function)(*args,**kwargs)


def test_camera_validation_contains_before_after_per_physical_holdout():
    target, observations = camera_fixture()
    validation = engine().fit_camera(target, observations)['validation']
    assert len(validation['perPatch']) == 3
    assert all(p['patchId'] in ('6','7','8') for p in validation['perPatch'])
    assert set(validation['before']) == {'mean','median','p95','max'}
    assert set(validation['after']) == {'mean','median','p95','max'}


def test_camera_rejects_replay_reference_observations():
    target, observations = camera_fixture()
    for o in observations:
        for f in o['frames']: f['source'] = 'replay'
    with pytest.raises(ValueError, match='live'): engine().fit_camera(target, observations)


def test_capture_rejects_mixed_source_domains():
    f = frames()
    f[-1]['source'] = 'replay'
    assert 'source-changed' in engine().summarize_frames(f)['quality']['warnings']


def test_display_rejects_non_co_captured_card_or_witness():
    drives = [[.15,.15,.15], [.7,.2,.2], [.2,.7,.2], [.2,.2,.7], [.65,.65,.2], [.2,.65,.65],
              [.4,.4,.4], [.6,.3,.6], [.3,.6,.5]]
    obs = [{'drive':d, 'frames':frames(d, f'd{i}'), 'witnessFrames':frames(prefix=f'w{i}'),
            'cardFrames':frames((.3,.3,.3), f'c{i}'), 'cardPatchId':'same-card',
            'split':'train' if i<6 else 'holdout', 'patchId':f'd{i}', 'commandSequence':i+1}
           for i,d in enumerate(drives)]
    for f in obs[-1]['cardFrames']: f['capturedAt'] += 5000
    with pytest.raises(ValueError, match='co-capture'): engine().fit_display(obs)


def test_sampling_same_color_srgb_p3_is_one_canonical_linear_domain():
    e = engine()
    xyz = e.rgb_to_xyz([.3,.5,.7])
    p3 = e._encoded(xyz @ np.linalg.inv(e.MATRICES['display-p3']).T)
    p3_frames = frames(p3)
    for f in p3_frames: f['colorSpace'] = 'display-p3'
    np.testing.assert_allclose(e.summarize_frames(p3_frames)['rgb'], e.summarize_frames(frames((.3,.5,.7)))['rgb'], atol=1e-12)


def test_low_light_signed_xyz_lab_roundtrip_no_implicit_clipping():
    e = engine()
    xyz = np.array([[0,0,0], [.0001,.002,.003], [-.01,.001,.005]])
    for white in ('D50','D65'):
        np.testing.assert_allclose(e.lab_to_xyz(e.xyz_to_lab(xyz,white),white),xyz,atol=1e-15)


def test_rank_deficient_chromatic_fit_rejected_even_non_neutral_flags():
    target, observations = camera_fixture()
    for i, obs in enumerate(observations):
        for f in obs['frames']: f['pixels'] = [[.2+i*.03]*3]*32
    with pytest.raises(ValueError, match='coverage'): engine().fit_camera(target, observations)


def test_display_rejects_replay_instead_of_live_physical_witness():
    drives = [[.15,.15,.15], [.7,.2,.2], [.2,.7,.2], [.2,.2,.7], [.65,.65,.2], [.2,.65,.65],
              [.4,.4,.4], [.6,.3,.6], [.3,.6,.5]]
    obs = [{'drive':d, 'frames':frames(d, f'd{i}'), 'witnessFrames':frames(prefix=f'w{i}'),
            'split':'train' if i<6 else 'holdout', 'patchId':f'd{i}', 'commandSequence':i+1}
           for i,d in enumerate(drives)]
    for o in obs:
        for f in o['frames']+o['witnessFrames']: f['source'] = 'replay'
    with pytest.raises(ValueError, match='live'): engine().fit_display(obs)


def test_patterned_region_returns_review_components_not_single_catalog_truth():
    rgb = np.full((80,80,3), .25)
    rgb[:,40:] = [.7,.6,.5]
    region = {'polygon':[[0,0],[1,0],[1,1],[0,1]], 'exclusions':[], 'mode':'patterned'}
    result = engine().extract_region(rgb, region)
    assert result['quality']['status'] == 'rejected'
    assert result['quality']['representativeStatus'] == 'operatorReviewRequired'
    assert len(result['components']) == 2
    assert all(abs(c['fraction']-.5)<.01 for c in result['components'])
    assert all(c['physicallyVerified'] is False for c in result['components'])


def test_camera_rejects_actual_video_reuse_across_physical_patches():
    target, observations = camera_fixture()
    for o in observations:
        for i,f in enumerate(o['frames']):
            f['presentedFrames'] = i+1
            f['mediaTime'] = i*.12
            f.pop('roi')
    with pytest.raises(ValueError, match='ROI'): engine().fit_camera(target, observations)


@pytest.mark.parametrize('mixture', [[[.8,.2,.2],[.2,.8,.8]], [[.8,.2,.2],[.2,.8,.2],[.2,.2,.8]]])
def test_identical_multicolor_mixtures_in_every_block_are_not_single_color(mixture):
    f = frames()
    for frame in f:
        frame['pixels'] = [mixture[j % len(mixture)] for j in range(32)]
    result = engine().summarize_frames(f)
    assert result['quality']['status'] == 'rejected'
    assert 'within-block-nonuniformity' in result['quality']['warnings']
    assert result['quality']['withinBlockSpread'] > .08


@pytest.mark.parametrize('rgb', [[5,-2,3], [.45,.45,.45]])
def test_camera_rejects_extrapolation_even_inside_axis_bounds(rgb):
    target, obs = camera_fixture()
    profile = engine().fit_camera(target,obs)
    with pytest.raises(ValueError, match='training'): engine().apply_camera(rgb,profile)


def test_camera_stores_training_hull_and_allows_convex_interpolation():
    e = engine()
    target, obs = camera_fixture()
    profile = e.fit_camera(target,obs)
    assert profile['cameraDomain']['policy'] == 'training-convex-hull'
    rgb = np.mean([e.summarize_frames(o['frames'])['rgb'] for o in obs[:6]],axis=0)
    np.testing.assert_allclose(e.apply_camera(rgb,profile),rgb @ e.MATRICES['srgb'].T,atol=1e-6)
    profile['matrix'][1] = [-1,-1,-1]
    with pytest.raises(ValueError, match='XYZ'): e.apply_camera(rgb,profile)


def test_match_requires_three_stable_batches_at_same_drive():
    match = engine().BoundedMatch([.5,.5,.5],[.5,.5,.5],.002,20,.01)
    first = match.observe([.5,.5,.5])
    assert first['status'] == 'running' and first['nextDrive'] == [.5,.5,.5]
    assert match.observe([.501,.5,.5])['status'] == 'running'
    third = match.observe([.5,.5,.5])
    assert third['status'] == 'complete' and third['iterations'] == 3


def test_lucky_matching_batch_does_not_survive_unstable_recheck():
    match = engine().BoundedMatch([.5,.5,.5],[.5,.5,.5],.002,20,.01)
    assert match.observe([.5,.5,.5])['status'] == 'running'
    result = match.observe([.7,.7,.7])
    assert result['status'] == 'running'
    assert result['objectiveValue'] > .3


def test_match_full_norm_and_noise_floor_prevent_false_precision():
    match = engine().BoundedMatch([.5,.5,.5],[.5,.5,.5],.02,20,.001)
    response = [.506,.506,.506]
    result = match.observe(response)
    assert result['objectiveValue'] == pytest.approx(np.sqrt(3)*.006)
    match.observe(response)
    result = match.observe(response)
    assert result['status'] == 'stopped' and result['terminationReason'] == 'noise-floor'


def test_budget_cannot_complete_without_stable_confirmation():
    result = engine().BoundedMatch([.5]*3,[.5]*3,.002,1,.01).observe([.5]*3)
    assert result['status'] == 'stopped' and result['terminationReason'] == 'evaluation-budget'


@pytest.mark.parametrize('value', [0.,1.])
def test_replay_clipping_is_rejected_with_explicit_counts(value):
    result = engine().extract_region(np.full((80,80,3),value),
                                    {'polygon':[[0,0],[1,0],[1,1],[0,1]],'exclusions':[]})
    assert result['quality']['status'] == 'rejected'
    assert 'clipped-pixels' in result['quality']['warnings']
    assert result['quality']['clippedPixels'] == 6400
    assert result['quality']['clippedRate'] == 1


def co_captured_camera_fixture():
    target, observations = camera_fixture()
    for n,o in enumerate(observations):
        x,y = (n%3)/3,(n//3)/3
        for i,f in enumerate(o['frames']):
            f.update(id=f'actual-frame-{i}', presentedFrames=i+1,mediaTime=i*.12,
                     regionId=f'physical-{n}',width=900,height=900,
                     roi=[[x+.02,y+.02],[x+.3,y+.02],[x+.3,y+.3],[x+.02,y+.3]])
    return target,observations


def test_camera_accepts_same_video_frames_from_disjoint_physical_rois():
    target,observations = co_captured_camera_fixture()
    assert engine().fit_camera(target,observations)['status'] == 'referenced'


@pytest.mark.parametrize('case',['same','overlap','missing','dimensions','drifting'])
def test_camera_rejects_reused_or_unproven_roi_even_with_different_ids(case):
    target,observations = co_captured_camera_fixture()
    for i,f in enumerate(observations[1]['frames']):
        f['id'] = f'unique-id-{i}'
        if case=='same': f['roi'] = observations[0]['frames'][i]['roi']
        if case=='overlap': f['roi'] = [[.1,.1],[.4,.1],[.4,.4],[.1,.4]]
        if case=='missing': f.pop('roi')
        if case=='dimensions': f['width'] = 1800
        if case=='drifting' and i==9: f['roi'] = [[.6,.6],[.9,.6],[.9,.9],[.6,.9]]
    with pytest.raises(ValueError,match='ROI'): engine().fit_camera(target,observations)


def test_camera_unique_patch_and_client_ids_are_not_roi_evidence():
    target,observations = camera_fixture()
    for o in observations:
        for f in o['frames']: f.pop('roi')
    with pytest.raises(ValueError,match='ROI'): engine().fit_camera(target,observations)


def test_exclusion_rate_uses_total_count_not_double_counted_removed_pixels():
    f = frames()
    for a in f:
        a.update(pixelCount=100,excludedCount=75,pixels=a['pixels'][:25],blockIds=[j//6 for j in range(25)])
    result = engine().summarize_frames(f)
    assert result['quality']['excludedRate'] == .75
    assert result['quality']['status'] == 'rejected'


def test_frame_total_count_cannot_hide_excluded_samples():
    f = frames()
    f[0]['excludedCount'] = 10
    with pytest.raises(ValueError,match='counts'): engine().summarize_frames(f)


def display_identity_fixture():
    drives = [[.15,.15,.15],[.7,.2,.2],[.2,.7,.2],[.2,.2,.7],[.65,.65,.2],[.2,.65,.65],
              [.4,.4,.4],[.6,.3,.6],[.3,.6,.5]]
    obs = []
    for n,d in enumerate(drives):
        o = {'drive':d,'frames':frames(d,f'd{n}'),'witnessFrames':frames(prefix=f'w{n}'),
             'cardFrames':frames((.3,.3,.3),f'c{n}'),'cardPatchId':'card',
             'split':'train' if n<6 else 'holdout','patchId':f'd{n}','commandSequence':n+1}
        for group in (o['frames'],o['witnessFrames'],o['cardFrames']):
            for i,f in enumerate(group):
                f.update(mediaTime=n*2+i*.12,presentedFrames=n*20+i+1,capturedAt=n*2000+i*120)
        obs.append(o)
    return obs


@pytest.mark.parametrize('case',['interior','identity','command-reuse'])
def test_display_cocapture_checks_each_frame_not_only_endpoints(case):
    observations = display_identity_fixture()
    if case=='interior': observations[-1]['cardFrames'][3]['mediaTime'] += .11
    if case=='identity':
        for f in observations[-1]['cardFrames']: f['presentedFrames'] += 1000
    if case=='command-reuse':
        for group in ('frames','witnessFrames','cardFrames'):
            for a,b in zip(observations[-1][group],observations[0][group]):
                a['mediaTime'],a['presentedFrames'] = b['mediaTime'],b['presentedFrames']
    with pytest.raises(ValueError,match='capture|video|witness'): engine().fit_display(observations)


def test_witness_rejects_actual_same_video_with_renamed_client_ids():
    a,b = frames(prefix='a'),frames(prefix='b')
    for group in (a,b):
        for i,f in enumerate(group): f.update(presentedFrames=i+1,mediaTime=i*.12)
    assert engine().check_witness(a,b) is False
