from contextlib import contextmanager

import pytest

from test_api import client, new_session, auth
from test_protocol import join, message


def preview(frame=1, stream="random_camera_cycle_1234"):
    return {"streamId": stream, "bands": [
        {"id": "band-1", "drive": [.2, .4, .6], "top": .05, "bottom": .4},
        {"id": "band-2", "drive": [.6, .3, .2], "top": .5, "bottom": .95}],
        "mapping": "screenAligned", "sourceFrame": {"mediaTime": float(frame / 10),
        "presentedFrames": frame, "width": 640, "height": 480}, "warnings": []}


@contextmanager
def active(c, s):
    path = "/ws/" + s["sessionId"]
    with c.websocket_connect(path, headers=auth(s)) as camera:
        join(camera, s, "camera")
        with c.websocket_connect(path, headers=auth(s)) as display:
            join(display, s, "display")
            camera.send_json(message(s, "camera", "session.resume", {"witnessChecked": True}, 2))
            camera.receive_json()
            display.receive_json()
            yield camera, display


def test_actual_live_bands_forwarded_both_roles_render_ack_not_measurement():
    with client() as c:
        s = new_session(c, "cameraMatch")
        url = "/api/sessions/" + s["sessionId"]
        with active(c, s) as (camera, display):
            response = c.post(url + "/live-preview", json=preview(), headers=auth(s))
            assert response.status_code == 200, response.text
            patch = response.json()
            from colorlab.models import LiveBandsCommand
            LiveBandsCommand.model_validate(patch)
            assert patch["layout"] == "liveBands"
            assert patch["purpose"] == "cameraAppearancePreview"
            assert patch["bands"] == preview()["bands"]
            assert patch["sourceFrame"] == preview()["sourceFrame"]
            assert patch["sampleIds"] == ["band-1", "band-2"]
            assert camera.receive_json()["payload"] == patch
            assert display.receive_json()["payload"] == patch
            display.send_json(message(s, "display", "display.patch.rendered", {
                "profileVersion": 0, "patchId": patch["patchId"],
                "commandSequence": patch["commandSequence"], "renderedAt": 1.}, 2))
            camera.receive_json()
            display.receive_json()
            snapshot = c.get(url, headers=auth(s)).json()
            assert snapshot["currentPatch"]["rendered"] is True
            assert snapshot["measurements"] == []
            assert snapshot["cameraProfile"] is None
            assert snapshot["displayProfile"] is None
            from test_camera_match import target_body
            assert c.post(url + "/camera-matches", json=target_body(), headers=auth(s)).json()["detail"] == "preview_must_pause_before_match"


def test_mobile_zero_media_clock_still_streams_preview_by_real_frame_counter_without_measurement_claim():
    with client() as c:
        s=new_session(c,"cameraMatch")
        url="/api/sessions/"+s["sessionId"]+"/live-preview"
        with active(c,s) as (camera,display):
            for index in range(1,7):
                body=preview(index);body["sourceFrame"]["mediaTime"]=0
                c.app.state.sessions[s["sessionId"]]["previewIssuedAt"]=0
                response=c.post(url,json=body,headers=auth(s));assert response.status_code==200,response.text
                assert response.json()["purpose"]=="cameraAppearancePreview"
                assert "mediaClockUnavailable" in response.json()["warnings"]
                camera.receive_json();display.receive_json()
            assert c.post(url,json=body,headers=auth(s)).status_code==409
            state=c.app.state.sessions[s["sessionId"]]
            assert state["measurements"]==[] and state["cameraProfile"] is None


def test_preview_new_frame_stream_epoch_rate_and_active_match_gates():
    from colorlab.protocol import pause
    with client() as c:
        s = new_session(c, "cameraMatch")
        url = "/api/sessions/" + s["sessionId"] + "/live-preview"
        assert c.post(url, json=preview(), headers=auth(s)).status_code == 409
        with active(c, s) as (camera, display):
            state = c.app.state.sessions[s["sessionId"]]
            assert c.post(url, json=preview(), headers=auth(s)).status_code == 200
            camera.receive_json(); display.receive_json()
            assert c.post(url, json=preview(), headers=auth(s)).json()["detail"] == "fresh_actual_preview_frame_required"
            fast = c.post(url, json=preview(2), headers=auth(s))
            assert fast.status_code == 409
            assert fast.json()["detail"]["code"] == "preview_rate_limit"
            assert 0 < fast.json()["detail"]["retryAfterMs"] <= 500
            state["previewIssuedAt"] -= .5
            assert c.post(url, json=preview(2), headers=auth(s)).status_code == 200
            camera.receive_json(); display.receive_json()
            old_time = preview(3)
            old_time["sourceFrame"]["mediaTime"] = .2
            assert c.post(url, json=old_time, headers=auth(s)).status_code == 409
            changed_dimensions = preview(3)
            changed_dimensions["sourceFrame"]["width"] = 1280
            assert c.post(url, json=changed_dimensions, headers=auth(s)).json()["detail"] == "preview_stream_dimensions_changed"
            assert c.post(url, json=preview(3, "different_camera_cycle_1234"), headers=auth(s)).status_code == 409
            state["runs"]["r"] = {"mode": "cameraMatch"}
            assert c.post(url, json=preview(3), headers=auth(s)).json()["detail"] == "match_already_active"
            pause(state, "camera_track_ended")
            state.update(paused=False, previewIssuedAt=0)
            assert c.post(url, json=preview(1), headers=auth(s)).status_code == 409
            assert c.post(url, json=preview(1, "different_camera_cycle_1234"), headers=auth(s)).status_code == 200


@pytest.mark.parametrize("mutate", [
    lambda p: p["bands"][0].update(top=.4),
    lambda p: p["bands"][1].update(top=.2),
    lambda p: p["bands"][1].update(id="band-1"),
    lambda p: p["bands"][0].update(drive=[True, .2, .3]),
    lambda p: p.update(bands=p["bands"] * 17),
    lambda p: p.update(warnings=["arbitrary private message"]),
    lambda p: p["sourceFrame"].update(presentedFrames=True),
    lambda p: p["sourceFrame"].update(width=0),
    lambda p: p.update(streamId="phone label"),
])
def test_preview_strict_bounded_geometry_and_provenance(mutate):
    with client() as c:
        s = new_session(c, "cameraMatch")
        payload = preview()
        mutate(payload)
        assert c.post("/api/sessions/" + s["sessionId"] + "/live-preview", json=payload, headers=auth(s)).status_code == 422


def test_preview_history_does_not_evict_control_or_exhaust_after_thirty_seconds():
    from colorlab.protocol import command
    state = {"paused": False, "devices": {"display": {}}, "commands": {},
             "commandSequence": 0, "profileVersion": 0, "lifecycleRevision": 0}
    control = command(state, [.5] * 3, "calibration")
    state["commands"][control["commandSequence"]]["rendered"] = True
    for i in range(200):
        patch = command(state, [.2] * 3, f"preview-{i}", "liveBands", preview=preview(i))
        state["commands"][patch["commandSequence"]]["rendered"] = True
    assert state["commands"][1]["patchId"] == "calibration"
    assert len(state["commands"]) <= 2
    assert state["currentPatch"]["commandSequence"] == 201


def test_three_stage_preview_cannot_bypass_order_origin_role_or_expiry():
    with client() as c:
        s = new_session(c)
        url = "/api/sessions/" + s["sessionId"] + "/live-preview"
        assert c.post(url, json=preview(), headers=auth(s)).status_code == 409
        assert c.post(url, json=preview(), headers={**auth(s), "Authorization": "Bearer " + s["displayToken"]}).status_code == 401
        assert c.post(url, json=preview(), headers={**auth(s), "Origin": "https://evil.test"}).status_code == 403
        c.app.state.sessions[s["sessionId"]]["expiry"] = 0
        assert c.post(url, json=preview(), headers=auth(s)).status_code == 401


def test_preview_history_replaces_unrendered_preview_and_preserves_controls_at_limit():
    from colorlab.protocol import command
    state = {"paused": False, "devices": {"display": {}}, "commands": {},
             "commandSequence": 0, "profileVersion": 0, "lifecycleRevision": 0}
    for i in range(63):
        command(state, [.5] * 3, f"control-{i}")
    command(state, [.2] * 3, "pending-preview", "liveBands", preview=preview())
    command(state, [.2] * 3, "another", "liveBands", preview=preview(2))
    assert len(state["commands"]) == 64
    assert 64 not in state["commands"]
    assert state["currentPatch"]["patchId"] == "another"
    assert state["commands"][65]["rendered"] is False
    assert all(state["commands"][i]["patchId"] == f"control-{i - 1}" for i in range(1, 64))


def test_five_hundred_unacked_previews_preserve_only_latest_and_scientific_control():
    from colorlab.protocol import command
    state = {"paused": False, "devices": {"display": {}}, "commands": {},
             "commandSequence": 0, "profileVersion": 0, "lifecycleRevision": 0}
    control = command(state, [.5] * 3, "scientific-control")
    for i in range(500):
        latest = command(state, [.2] * 3, f"preview-{i}", "liveBands", preview=preview(i))
        assert len(state["commands"]) == 2
        assert state["commands"][1]["patchId"] == control["patchId"]
        assert latest["rendered"] is False
    assert state["commandSequence"] == latest["markerSequence"] == 501
    assert set(state["commands"]) == {1, 501}
    assert state["currentPatch"]["patchId"] == "preview-499"


def test_late_ack_of_retired_preview_cannot_restore_render_or_scientific_evidence():
    with client() as c:
        s = new_session(c, "cameraMatch")
        url = "/api/sessions/" + s["sessionId"]
        with active(c, s) as (camera, display):
            first = c.post(url + "/live-preview", json=preview(), headers=auth(s)).json()
            camera.receive_json(); display.receive_json()
            state = c.app.state.sessions[s["sessionId"]]
            state["previewIssuedAt"] -= .5
            latest = c.post(url + "/live-preview", json=preview(2), headers=auth(s)).json()
            camera.receive_json(); display.receive_json()
            assert first["commandSequence"] not in state["commands"]
            display.send_json(message(s, "display", "display.patch.rendered", {
                "profileVersion": 0, "patchId": first["patchId"],
                "commandSequence": first["commandSequence"], "renderedAt": 1.}, 2))
            assert display.receive_json()["payload"]["code"] == "stale_render"
            snapshot = c.get(url, headers=auth(s)).json()
            assert snapshot["currentPatch"]["commandSequence"] == latest["commandSequence"]
            assert snapshot["currentPatch"]["rendered"] is False
            assert snapshot["measurements"] == []
            assert snapshot["cameraProfile"] is snapshot["displayProfile"] is None


def test_slow_device_queue_coalesces_only_superseded_live_bands_preserving_control_order():
    import asyncio
    from colorlab.protocol import emit

    async def check():
        devices = {role: {"queue": asyncio.Queue(maxsize=8), "serverSequence": 0,
                          "overflow": asyncio.Event()} for role in ("camera", "display")}
        state = {"sessionId": "test", "devices": devices, "commands": {}, "runs": {},
                 "currentPatch": None, "paused": False}
        control = {"layout": "single", "patchId": "scientific", "commandSequence": 1}
        await emit(state, "display.patch.set", control)
        await emit(state, "heartbeat", {"localTime": 1.})
        for sequence in range(2, 6):
            await emit(state, "display.patch.set", {"layout": "liveBands", "purpose": "cameraAppearancePreview",
                                                    "commandSequence": sequence})
            if sequence == 2:
                await emit(state, "session.state", {"state": "fabric"})
            if sequence == 3:
                await emit(state, "display.patch.rendered", {"commandSequence": sequence})
        for device in devices.values():
            queue = device["queue"]
            rows = [queue.get_nowait() for _ in range(queue.qsize())]
            assert [row["event"] for row in rows] == ["display.patch.set", "heartbeat", "session.state",
                                                        "display.patch.rendered", "display.patch.set"]
            assert rows[0]["payload"] == control
            assert rows[-1]["payload"]["commandSequence"] == 5
            assert [row["sequenceId"] for row in rows] == [1, 2, 4, 6, 8]
            assert not device["overflow"].is_set()
        assert state["paused"] is False
    asyncio.run(check())


def test_full_slow_queue_replaces_preview_without_backpressure_or_dropping_metadata():
    import asyncio
    from colorlab.protocol import emit

    async def check():
        queue = asyncio.Queue(maxsize=4)
        device = {"queue": queue, "serverSequence": 0, "overflow": asyncio.Event()}
        state = {"sessionId": "test", "devices": {"display": device}, "commands": {}, "runs": {},
                 "currentPatch": None, "paused": False}
        for event in ("heartbeat", "session.state", "quality.alert"):
            await emit(state, event, {})
        for sequence in range(1, 501):
            await emit(state, "display.patch.set", {"layout": "liveBands", "purpose": "cameraAppearancePreview",
                                                    "commandSequence": sequence})
            assert queue.qsize() == 4
        rows = [queue.get_nowait() for _ in range(4)]
        assert [row["event"] for row in rows] == ["heartbeat", "session.state", "quality.alert", "display.patch.set"]
        assert rows[-1]["payload"]["commandSequence"] == 500
        assert rows[-1]["sequenceId"] == 503
        assert state["paused"] is False
        assert not device["overflow"].is_set()
    asyncio.run(check())
