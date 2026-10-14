from test_camera_match import active
from test_api import client, new_session, auth, frames, physical_batch


def body():
    cards = []
    for index, (role, value) in enumerate((('dark', .08), ('middle', .4), ('light', .8))):
        batch = physical_batch(frames('neutral-' + role, value), 60, index)
        cards.append({'role': role, 'frames': batch})
    return {'cards': cards, 'fingerprint': 'settings-1'}


def test_three_actual_unknown_cards_are_stability_evidence_not_color_calibration():
    with client() as c:
        s = new_session(c, 'cameraMatch')
        base = '/api/sessions/' + s['sessionId']
        with active(c, s):
            response = c.post(base + '/neutral-check', headers=auth(s), json=body())
            assert response.status_code == 200, response.text
            report = response.json()
            assert report['referenceValuesKnown'] is False
            assert report['fullColorCalibration'] is False
            assert report['cameraControlsApplied'] is False
            assert report['status'] == 'limitedNeutralCheck'
            assert len(report['cards']) == 3
            assert c.get(base, headers=auth(s)).json()['cameraProfile'] is None
            exported = c.get(base + '/export', headers=auth(s)).json()
            assert exported['neutralCheck']['referenceValuesKnown'] is False
            assert c.post(base + '/neutral-check', headers=auth(s), json=body()).status_code == 409


def test_neutral_check_rejects_wrong_roles_and_not_co_captured_cards():
    with client() as c:
        s = new_session(c, 'cameraMatch')
        base = '/api/sessions/' + s['sessionId']
        with active(c, s):
            wrong = body()
            wrong['cards'][0]['role'] = 'middle'
            assert c.post(base + '/neutral-check', headers=auth(s), json=wrong).status_code == 422


def test_neutral_check_requires_live_source_and_constant_physical_card_geometry():
    with client() as c:
        s = new_session(c, 'cameraMatch')
        base = '/api/sessions/' + s['sessionId']
        with active(c,s):
            wrong = body()
            for card in wrong['cards']:
                for frame in card['frames']: frame['source'] = 'replay'
            assert c.post(base+'/neutral-check',headers=auth(s),json=wrong).status_code == 422
            wrong = body()
            wrong['cards'][0]['frames'][3]['roi'] = [[.8,.8],[.9,.8],[.9,.9],[.8,.9]]
            assert c.post(base+'/neutral-check',headers=auth(s),json=wrong).status_code == 422
            wrong = body()
            wrong['cards'][1]['frames'][3]['mediaTime'] += .2
            assert c.post(base + '/neutral-check', headers=auth(s), json=wrong).status_code == 422
