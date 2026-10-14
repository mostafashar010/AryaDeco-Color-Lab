import pytest
from starlette.websockets import WebSocketDisconnect

from test_api import client, new_session, auth


def message(s, role, event, payload, seq=1):
    return {"event": event, "protocolVersion": 1, "sessionId": s["sessionId"],
            "messageId": f"{role}-{seq}", "sequenceId": seq, "role": role, "payload": payload}


def join(ws, s, role):
    ws.send_json(message(s, role, "device.join", {"token": s[role + "Token"]}))
    data = ws.receive_json()
    assert data["event"] == "session.state"
    assert data["role"] == "server"
    return data


def test_ws_join_origin_role_ownership_sequence_and_disconnect_pause():
    with client() as c:
        s = new_session(c)
        path = "/ws/" + s["sessionId"]
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect(path, headers={"Origin": "http://evil.local"}):
                pass
        with c.websocket_connect(path, headers={"Origin": "http://localhost:8443"}) as camera:
            assert join(camera, s, "camera")["payload"]["paused"]
            with pytest.raises(WebSocketDisconnect):
                with c.websocket_connect(path, headers={"Origin": "http://localhost:8443"}) as duplicate:
                    join(duplicate, s, "camera")
            camera.send_json(message(s, "camera", "heartbeat", {"localTime": 0}, 2))
            assert camera.receive_json()["event"] == "heartbeat"
            camera.send_json(message(s, "camera", "heartbeat", {"localTime": 0}, 2))
            assert camera.receive_json()["event"] == "quality.alert"
        assert c.get("/api/sessions/" + s["sessionId"], headers=auth(s)).json()["paused"]


def test_display_cannot_spoof_measurement_or_patch_command():
    with client() as c:
        s = new_session(c)
        with c.websocket_connect("/ws/" + s["sessionId"], headers={"Origin": "http://localhost:8443"}) as display:
            join(display, s, "display")
            display.send_json(message(s, "display", "measurement.submit", {}, 2))
            assert display.receive_json()["payload"]["code"] == "event_not_allowed"
            display.send_json(message(s, "display", "display.patch.set", {
                "profileVersion": 0, "patchId": "p", "displayDriveRgb": [0.1, 0.2, 0.3],
                "layout": "single", "sampleIds": []}, 3))
            assert display.receive_json()["payload"]["code"] == "role_forbidden"


def test_server_command_render_ack_and_marker_decoder_are_not_client_proof():
    from colorlab.protocol import decode_marker
    cells = [[float(bit)] * 3 for bit in [0, 1, 0, 1] + [int(x) for x in f"{37:024b}"]]
    assert decode_marker(cells) == 37
    with pytest.raises(ValueError):
        decode_marker([[0.5] * 3] * 28)
    with client() as c:
        s = new_session(c)
        path = "/ws/" + s["sessionId"]
        with c.websocket_connect(path, headers={"Origin": "http://localhost:8443"}) as camera:
            join(camera, s, "camera")
            with c.websocket_connect(path, headers={"Origin": "http://localhost:8443"}) as display:
                join(display, s, "display")
                camera.send_json(message(s, "camera", "session.resume", {"witnessChecked": True}, 2))
                assert camera.receive_json()["event"] == "session.state"
                assert display.receive_json()["event"] == "session.state"
                camera.send_json(message(s, "camera", "display.patch.set", {"profileVersion": 0,
                    "patchId": "p", "displayDriveRgb": [0.4] * 3, "layout": "single", "sampleIds": []}, 3))
                patch = camera.receive_json()["payload"]
                assert display.receive_json()["payload"]["commandSequence"] == 1
                assert not patch["rendered"]
                display.send_json(message(s, "display", "display.patch.rendered", {"profileVersion": 0,
                    "patchId": "p", "commandSequence": 1, "renderedAt": 1.}, 2))
                assert display.receive_json()["event"] == "display.patch.rendered"
                assert camera.receive_json()["event"] == "display.patch.rendered"
                snap = c.get("/api/sessions/" + s["sessionId"], headers=auth(s)).json()
                assert snap["currentPatch"]["rendered"]
                assert snap["displayProfile"] is None


def test_group_cards_remain_unverified_and_cannot_change_catalog():
    with client() as c:
        s = new_session(c)
        path = "/ws/" + s["sessionId"]
        with c.websocket_connect(path, headers={"Origin": "http://localhost:8443"}) as camera:
            join(camera, s, "camera")
            with c.websocket_connect(path, headers={"Origin": "http://localhost:8443"}) as display:
                join(display, s, "display")
                camera.send_json(message(s, "camera", "session.resume", {"witnessChecked": True}, 2))
                camera.receive_json()
                display.receive_json()
                camera.send_json(message(s, "camera", "display.patch.set", {"profileVersion": 0,
                    "patchId": "group", "displayDriveRgb": [0.4] * 3, "layout": "group", "sampleIds": ["a", "b"],
                    "patches": [{"sampleId": "a", "drive": [0.2] * 3}, {"sampleId": "b", "drive": [0.7] * 3}]}, 3))
                data = camera.receive_json()
                assert data["event"] == "display.patch.set", data
                assert len(data["payload"]["patches"]) == 2
                assert data["payload"]["groupStatus"] == "unverified"
                assert display.receive_json()["payload"]["patches"][1]["drive"] == [0.7] * 3


def test_oversized_message_and_heartbeat_timeout_pause(monkeypatch):
    import colorlab.protocol as protocol
    monkeypatch.setattr(protocol, "HEARTBEAT_SECONDS", 0.03)
    with client() as c:
        s = new_session(c)
        path = "/ws/" + s["sessionId"]
        with c.websocket_connect(path, headers={"Origin": "http://localhost:8443"}) as camera:
            join(camera, s, "camera")
            with pytest.raises(WebSocketDisconnect):
                camera.receive_json()
        assert c.get("/api/sessions/" + s["sessionId"], headers=auth(s)).json()["paused"]
    monkeypatch.setattr(protocol, "HEARTBEAT_SECONDS", 30)
    with client() as c:
        s = new_session(c)
        with c.websocket_connect("/ws/" + s["sessionId"], headers={"Origin": "http://localhost:8443"}) as camera:
            join(camera, s, "camera")
            camera.send_text("x" * 65537)
            with pytest.raises(WebSocketDisconnect):
                camera.receive_json()


def test_backpressure_has_bounded_queue_and_invalidates_current_command():
    import asyncio
    from colorlab.protocol import emit
    async def check():
        s = {"sessionId": "s", "devices": {"camera": {"queue": asyncio.Queue(maxsize=1), "serverSequence": 0, "overflow": asyncio.Event()}},
             "runs": {"run": {}}, "commands": {1: {}}, "paused": False, "currentPatch": {"patchId": "p"}}
        await emit(s, "heartbeat", {})
        await emit(s, "heartbeat", {})
        assert s["paused"]
        assert s["currentPatch"] is None
        assert not s["runs"]
        assert s["devices"]["camera"]["overflow"].is_set()
    asyncio.run(check())


def test_capability_unknown_space_and_constraints_remain_explicit():
    with client() as c:
        s = new_session(c)
        with c.websocket_connect("/ws/" + s["sessionId"], headers={"Origin": "http://localhost:8443"}) as camera:
            join(camera, s, "camera")
            payload = {"browserSupported": True, "trackCapabilities": {}, "requested": {}, "reportedSettings": {},
                       "supportedConstraints": {"exposureMode": False}, "controlStatus": {}, "deviceLabel": "unknown",
                       "capturePath": "videoCanvas", "canvasColorSpace": "unknown", "wakeLock": False}
            camera.send_json(message(s, "camera", "capabilities.report", payload, 2))
            event = camera.receive_json()
            assert event["event"] == "session.state", event
            assert event["payload"]["capabilities"]["camera"]["canvasColorSpace"] == "unknown"


def test_display_brightness_capability_change_preserves_camera_profile():
    with client() as c:
        s = new_session(c, "catalogOnly")
        url = "/api/sessions/" + s["sessionId"]
        c.post(url + "/reference", headers=auth(s), json={"exploratory": True})
        c.post(url + "/camera-profile", headers=auth(s), json={"observations": [], "fingerprint": "f"})
        with c.websocket_connect("/ws/" + s["sessionId"], headers={"Origin": "http://localhost:8443"}) as display:
            join(display, s, "display")
            payload = {"browserSupported": True, "trackCapabilities": {}, "requested": {}, "reportedSettings": {"brightness": 0.5},
                       "controlStatus": {}, "deviceLabel": "display", "capturePath": "css", "canvasColorSpace": "srgb", "wakeLock": False}
            display.send_json(message(s, "display", "capabilities.report", payload, 2))
            display.receive_json()
            payload["reportedSettings"]["brightness"] = 0.8
            display.send_json(message(s, "display", "capabilities.report", payload, 3))
            result = display.receive_json()["payload"]
            assert result["cameraProfile"] is not None
            assert result["displayProfile"] is None


def test_pause_discards_pending_stale_commands():
    import asyncio
    from colorlab.protocol import pause
    queue = asyncio.Queue(maxsize=32)
    queue.put_nowait({"event": "display.patch.set", "payload": {"commandSequence": 1}})
    s = {"devices": {"display": {"queue": queue}}, "runs": {}, "commands": {1: {}}, "currentPatch": {}}
    pause(s, "disconnect")
    assert queue.empty()
