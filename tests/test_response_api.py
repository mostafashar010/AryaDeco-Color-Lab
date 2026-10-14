"""Synthetic co-capture protocol tests; no hardware or absolute color claims."""
import copy
import numpy as np
import pytest

from test_api import auth, client, frames, new_session, physical_batch
from test_camera_match import active, render


def relative_batch(name, rgb, sequence, number, roi_index):
    batch = physical_batch(frames(f'{name}-{number}'), number, roi_index)
    marker = [[float(bit)] * 3 for bit in [0, 1, 0, 1] + [int(x) for x in f'{sequence:024b}']]
    for frame in batch:
        frame.update(pixels=[list(rgb)] * 16, mediaTime=0., exclusions=[],
                     markerSequence=sequence, markerPixels=marker)
    return batch


def observe_body(run, number):
    from test_display_response import synthetic_response
    rgb = synthetic_response(run['nextDrive'])
    encoded = np.where(rgb <= .0031308, rgb * 12.92, 1.055 * rgb ** (1 / 2.4) - .055)
    return {'fingerprint': 'settings-1', 'width': 640, 'height': 480, 'streamId': 'response-stream-1',
            'phase': run['phase'], 'commandSequence': run['commandSequence'], 'patchId': run['patchId'],
            'frames': relative_batch('screen', encoded, run['commandSequence'], number, 0),
            'cardFrames': relative_batch('card', [.45] * 3, run['commandSequence'], number, 1),
            'referenceRole': 'middle'}


START = {'fingerprint': 'settings-1', 'width': 640, 'height': 480, 'streamId': 'response-stream-1'}


def drain(camera, display):
    for ws in (camera, display):
        assert ws.receive_json()['event'] == 'display.patch.set'
        assert ws.receive_json()['event'] == 'capture.request'


def test_response_run_server_commands_zero_clock_profile_and_inversion():
    with client() as c:
        session = new_session(c, 'cameraMatch')
        base = '/api/sessions/' + session['sessionId']
        with active(c, session) as (camera, display):
            started = c.post(base + '/response-profile/start', json=START, headers=auth(session))
            assert started.status_code == 200, started.text
            run = started.json()
            for number in range(1, 12):
                assert run['step'] == number
                assert all(.08 <= channel <= .8 for channel in run['nextDrive'])
                drain(camera, display)
                render(camera, display, session, run, number + 1)
                result = c.post(base + '/response-profile/' + run['runId'] + '/observe',
                                json=observe_body(run, number), headers=auth(session))
                assert result.status_code == 200, result.text
                run = result.json()
            assert run['status'] == 'complete'
            for ws in (camera, display):
                assert ws.receive_json()['event'] == 'session.state'
            profile = c.get(base, headers=auth(session)).json()['responseProfile']
            assert profile['status'] == 'cameraReferencedExperimental'
            assert profile['rawMediaClockState'] == 'unavailable'
            assert profile['observations'][0]['frames'][0]['mediaTime'] == 0.
            assert profile['validation']['holdout']['max'] < .01
            assert 'observer' not in profile
            assert c.get(base + '/export', headers=auth(session)).json()['responseProfile'] == profile
            from test_display_response import synthetic_response
            wanted = synthetic_response([.4, .38, .42])
            encoded = 1.055 * wanted ** (1 / 2.4) - .055
            body = {**START, 'frames': relative_batch('cloth', encoded, 11, 12, 2),
                    'cardFrames': relative_batch('card', [.45] * 3, 11, 12, 1), 'referenceRole': 'middle'}
            inverse = c.post(base + '/response-profile/invert', json=body, headers=auth(session))
            assert inverse.status_code == 200, inverse.text
            assert inverse.json()['drive'] == pytest.approx([.4, .38, .42], abs=.006)
            assert inverse.json()['independentValidationStatus'] == 'notTested'
            live_body = {'streamId': 'new-preview-cycle', 'fingerprint': START['fingerprint'], 'canvasColorSpace': 'srgb',
                         'compensatedOnly': True, 'bands': [{'id': 'cloth', 'drive': encoded.tolist(), 'top': 0., 'bottom': 1.}],
                         'mapping': 'orderedPreview', 'sourceFrame': {'presentedFrames': 300, 'mediaTime': 0., 'width': 640, 'height': 480},
                         'warnings': []}
            preview = c.post(base + '/live-preview', json=live_body, headers=auth(session))
            assert preview.status_code == 200, preview.text
            patch = preview.json()
            assert patch['bands'][0]['drive'] == pytest.approx([.4, .38, .42], abs=.006)
            assert patch['cameraAppearanceBands'][0]['drive'] == pytest.approx(encoded)
            assert patch['compensation']['status'] == 'cameraReferencedExperimental'
            assert patch['compensation']['label'] == 'جبران پاسخ نمایشگر از دید دوربین، آزمایشی'
            from colorlab.models import LiveBandsCommand
            LiveBandsCommand.model_validate(patch)
            state = c.app.state.sessions[session['sessionId']]
            old_command = state['currentPatch']['commandSequence']
            bad_preview = copy.deepcopy(live_body)
            bad_preview['bands'][0]['drive'] = [.98] * 3
            bad_preview['sourceFrame']['presentedFrames'] += 1
            state['previewIssuedAt'] = 0.
            rejected = c.post(base + '/live-preview', json=bad_preview, headers=auth(session))
            assert rejected.status_code == 422
            assert state['currentPatch']['commandSequence'] == old_command
            c.app.state.sessions[session['sessionId']]['responseProfile']['expiresAt'] = 0.
            state = c.app.state.sessions[session['sessionId']]
            state['neutralCheck'] = {'status': 'limitedNeutralCheck'}
            assert c.get(base, headers=auth(session)).json()['neutralCheck'] is None
            assert c.get(base, headers=auth(session)).json()['responseProfile'] is None


def test_response_fit_failure_retains_evidence_and_cannot_compensate():
    with client() as c:
        session = new_session(c, 'cameraMatch')
        base = '/api/sessions/' + session['sessionId']
        with active(c, session) as (camera, display):
            run = c.post(base + '/response-profile/start', json=START, headers=auth(session)).json()
            assert run['nextDrive'] == [.5] * 3
            for number in range(1, 12):
                drain(camera, display)
                render(camera, display, session, run, number + 1)
                body = observe_body(run, number)
                if run['phase'] == 'holdout':
                    for frame in body['frames']:
                        frame['pixels'] = [[.8, .3, .4]] * 16
                response = c.post(base + '/response-profile/' + run['runId'] + '/observe', json=body, headers=auth(session))
                assert response.status_code == 200, response.text
                run = response.json()
            assert run['status'] == 'invalid'
            profile = run['responseProfile']
            assert profile['validProfile'] is False
            assert len(profile['observations']) == 11
            assert profile['errorCode'] == 'response_normalized_rgb_validation_failed'
            assert 'parameters' not in profile


def test_pending_response_observation_cannot_commit_after_cancel(monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from colorlab import display_response
    original = display_response.paired_relative
    entered, released = threading.Event(), threading.Event()
    def delayed(*args, **kwargs):
        entered.set()
        assert released.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(display_response, 'paired_relative', delayed)
    with client() as c:
        session = new_session(c, 'cameraMatch')
        base = '/api/sessions/' + session['sessionId']
        with active(c, session) as (camera, display):
            run = c.post(base + '/response-profile/start', json=START, headers=auth(session)).json()
            drain(camera, display)
            render(camera, display, session, run, 2)
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(c.post, base + '/response-profile/' + run['runId'] + '/observe',
                                      json=observe_body(run, 1), headers=auth(session))
                assert entered.wait(5)
                cancelled = c.delete(base + '/response-profile', headers=auth(session))
                assert cancelled.status_code == 200
                released.set()
                assert pending.result(5).status_code == 409
            state = c.app.state.sessions[session['sessionId']]
            assert state['responseProfile'] is None
            assert state['runs'] == {}
            assert state['currentPatch'] is None


def test_response_cancel_and_missing_profile_raw_preview_warning():
    with client() as c:
        session = new_session(c, 'cameraMatch')
        base = '/api/sessions/' + session['sessionId']
        with active(c, session) as (camera, display):
            preview = {'streamId': 'raw-preview-cycle', 'bands': [{'id': 'cloth', 'drive': [.4] * 3, 'top': 0., 'bottom': 1.}],
                       'mapping': 'orderedPreview', 'sourceFrame': {'presentedFrames': 1, 'mediaTime': 0., 'width': 640, 'height': 480}, 'warnings': []}
            result = c.post(base + '/live-preview', json={**preview, 'compensatedOnly': True}, headers=auth(session))
            assert result.status_code == 409
            result = c.post(base + '/live-preview', json=preview, headers=auth(session))
            assert result.status_code == 200, result.text
            assert 'uncalibratedPreview' in result.json()['warnings']
            assert result.json()['compensation']['status'] == 'notCompensated'
            assert c.post(base + '/response-profile/start', json=START, headers=auth(session)).status_code == 409
            cancelled = c.delete(base + '/response-profile', headers=auth(session))
            assert cancelled.status_code == 200, cancelled.text
            assert c.get(base, headers=auth(session)).json()['paused'] is True


def test_response_requires_active_ownership_and_preserves_three_stage():
    with client() as c:
        for mode in ('threeStage', 'cameraMatch'):
            session = new_session(c, mode)
            base = '/api/sessions/' + session['sessionId']
            assert c.post(base + '/response-profile/start', json=START, headers=auth(session)).status_code == 409


def test_response_rejects_bad_pairing_provenance_phase_and_drift():
    with client() as c:
        session = new_session(c, 'cameraMatch')
        base = '/api/sessions/' + session['sessionId']
        with active(c, session) as (camera, display):
            run = c.post(base + '/response-profile/start', json=START, headers=auth(session)).json()
            drain(camera, display)
            body = observe_body(run, 1)
            url = base + '/response-profile/' + run['runId'] + '/observe'
            assert c.post(url, json=body, headers=auth(session)).status_code == 409
            render(camera, display, session, run, 2)
            mutations = [lambda b: b.update(phase='holdout'), lambda b: b.update(drive=[.4] * 3),
                         lambda b: b['frames'][0].update(source='replay'),
                         lambda b: b['frames'][0].update(width=320),
                         lambda b: b['frames'][0].update(markerPixels=None),
                         lambda b: b['frames'][0].update(mediaTime=None),
                         lambda b: b['frames'][1].update(presentedFrames=b['frames'][0]['presentedFrames']),
                         lambda b: b['frames'][0].update(roi=b['cardFrames'][0]['roi']),
                         lambda b: b['cardFrames'][0].update(capturedAt=99999.),
                         lambda b: b['cardFrames'][0].update(pixelCount=100000000),
                         lambda b: b['cardFrames'][0].update(settingsFingerprint='changed')]
            for change in mutations:
                bad = copy.deepcopy(body)
                change(bad)
                assert c.post(url, json=bad, headers=auth(session)).status_code in (409, 422)
            result = c.post(url, json=body, headers=auth(session))
            assert result.status_code == 200, result.text
            run = result.json()
            drain(camera, display)
            render(camera, display, session, run, 3)
            body = observe_body(run, 2)
            for frame in body['cardFrames']:
                frame['pixels'] = [[.49, .45, .45]] * 16
            result = c.post(base + '/response-profile/' + run['runId'] + '/observe', json=body, headers=auth(session))
            assert result.status_code == 422
            assert 'neutral_witness_drift' in result.text
            assert c.get(base, headers=auth(session)).json()['paused'] is True


def test_response_conditions_change_aborts_owned_run_and_cannot_restore_profile():
    with client() as c:
        session = new_session(c, 'cameraMatch')
        base = '/api/sessions/' + session['sessionId']
        with active(c, session) as (camera, display):
            run = c.post(base + '/response-profile/start', json=START, headers=auth(session)).json()
            drain(camera, display)
            render(camera, display, session, run, 2)
            c.patch(base + '/conditions', json={'conditions': {'displayBrightness': .7}}, headers=auth(session))
            result = c.post(base + '/response-profile/' + run['runId'] + '/observe', json=observe_body(run, 1), headers=auth(session))
            assert result.status_code == 409
            snapshot = c.get(base, headers=auth(session)).json()
            assert snapshot['responseProfile'] is None
            assert snapshot['cameraProfile'] is None
            assert snapshot['displayProfile'] is None


def test_zero_media_clock_remains_rejected_in_original_engine():
    from colorlab.engine import summarize_frames
    result = summarize_frames(relative_batch('old-route', [.4] * 3, 1, 1, 0))
    assert result['quality']['status'] == 'rejected'
    assert 'duplicate-video-frame' in result['quality']['warnings']
