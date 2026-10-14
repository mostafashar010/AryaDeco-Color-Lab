"""Synthetic numerical evidence, not a physical display validation."""
import numpy as np
import pytest

from colorlab.display_response import characterize, invert_response, response_steps, summarize_relative


def synthetic_response(drive):
    matrix = np.array([[.65, .08, .04], [.03, .72, .06], [.07, .04, .58]])
    return matrix @ np.asarray(drive) ** [1.7, 2.3, 1.9] + [.035, .045, .055]


def observations():
    return [{**step, 'patchId': f'p-{i}', 'rgb': synthetic_response(step['drive']).tolist()}
            for i, step in enumerate(response_steps())]


def test_measured_synthetic_gamma_crosstalk_offset_beats_raw_drive():
    profile = characterize(observations())
    wanted_drive = np.array([.4, .38, .42])
    target = synthetic_response(wanted_drive)
    raw_drive = np.where(target <= .0031308, target * 12.92, 1.055 * target ** (1 / 2.4) - .055)
    raw_error = np.linalg.norm(synthetic_response(raw_drive) - target)
    result = invert_response(profile, target)
    computed_actual_error = np.linalg.norm(synthetic_response(result['drive']) - target)
    assert result['outOfSupport'] is False
    assert result['drive'] == pytest.approx(wanted_drive, abs=.006)
    assert result['predictedResidual'] < raw_error / 20
    assert computed_actual_error < raw_error / 20
    assert profile['validation']['holdout']['max'] < .01
    assert profile['referenceValuesKnown'] is False
    assert profile['independentValidationStatus'] == 'notTested'
    print({'evidence': 'syntheticOnly', 'rawResidual': float(raw_error),
           'computedInverseResidual': result['predictedResidual'],
           'syntheticForwardAfterResidual': float(computed_actual_error)})


def test_insufficient_rank_holdout_and_extrapolation_fail_closed():
    with pytest.raises(ValueError):
        characterize(observations()[:-1])
    bad = observations()
    for observation in bad:
        observation['drive'] = [.4] * 3
    with pytest.raises(ValueError):
        characterize(bad)
    result = invert_response(characterize(observations()), [.95, .95, .95])
    assert result['outOfSupport'] is True
    assert result['drive'] is None
    assert result['physicalGamutConclusion'] is None


def test_zero_media_clock_is_limited_not_synthetic_time():
    from test_response_api import relative_batch
    frames = relative_batch('screen', [.4] * 3, 1, 1, 0)
    result = summarize_relative(frames)
    assert result['quality']['status'] == 'accepted'
    assert result['quality']['rawMediaClockState'] == 'unavailable'
    assert result['provenance'][0]['mediaTime'] == 0.
    assert 'effectiveTime' not in result['provenance'][0]
    frames[1]['presentedFrames'] = frames[0]['presentedFrames']
    with pytest.raises(ValueError):
        summarize_relative(frames)


def test_fractional_native_polygon_allows_actual_pixel_center_raster_count_but_not_arbitrary_counts():
    from test_response_api import relative_batch
    frames=relative_batch('fractional', [.4]*3, 1, 1, 0)
    polygon=[[10.49/640,20.49/480],[30.51/640,20.49/480],[30.51/640,40.51/480],[10.49/640,40.51/480]]
    # Pixel centers from 10.5 through 30.5: 21*21 despite continuous area 20.02**2.
    for frame in frames:frame.update(roi=polygon,pixelCount=441,excludedCount=0)
    assert summarize_relative(frames)['quality']['status']=='accepted'
    frames[0]['pixelCount']=1000
    with pytest.raises(ValueError,match='pixel_count_exceeds'):
        summarize_relative(frames)


@pytest.mark.parametrize('change', [
    lambda frames: frames.pop(),
    lambda frames: frames[0].update(capturedAt=100000.),
    lambda frames: frames[0].update(pixels=[[1.] * 3] * 16),
    lambda frames: frames[0].update(blockIds=[0] * 16),
    lambda frames: frames[0].update(roi=[[.1, .1], [.1, .1], [.1, .1]]),
    lambda frames: frames[0].update(source='replay'),
    lambda frames: frames[0].update(colorSpace='display-p3'),
])
def test_relative_stats_reject_incomplete_unstable_or_changed_native_frames(change):
    from test_response_api import relative_batch
    frames = relative_batch('screen', [.4] * 3, 1, 1, 0)
    change(frames)
    with pytest.raises(ValueError):
        summarize_relative(frames)


def test_holdout_must_validate_not_train_away_error():
    bad = observations()
    bad[-1]['rgb'] = [.9, .1, .2]
    with pytest.raises(ValueError, match='validation_failed'):
        characterize(bad)


def test_public_fit_and_preview_helpers_fail_closed_without_valid_profile():
    from colorlab.display_response import fit_display_response, compensate_preview
    profile = fit_display_response(observations())
    assert profile['validProfile'] is True
    assert 'observer' not in profile
    result = compensate_preview(synthetic_response([.4, .38, .42]), profile)
    assert result['status'] == 'cameraReferencedExperimental'
    assert result['drive'] == pytest.approx([.4, .38, .42], abs=.006)
    invalid = fit_display_response(observations()[:3])
    assert invalid['status'] == 'invalid'
    assert invalid['validProfile'] is False
    assert compensate_preview([.2] * 3, invalid)['drive'] is None
    assert compensate_preview([.2] * 3, None)['status'] == 'notCompensated'
