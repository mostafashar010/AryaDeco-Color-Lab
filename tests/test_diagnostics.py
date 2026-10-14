import hashlib
import json

import pytest
from fastapi.testclient import TestClient
from test_api import new_session, auth


def event(sequence=1):
    return {"sequence": sequence, "elapsedMs": float(sequence * 100), "area": "tracking",
            "event": "geometry", "details": {"width": 640, "height": 480, "cardCount": 2,
            "fresh": True, "status": "needsFraming", "reason": "unclassified"}}


def evidence_snapshot():
    return {"role": "camera", "stage": "sampled", "commandSequence": 7,
            "markerSequence": 7, "presentedFrames": 42, "rawMediaTime": 0.,
            "nativeWidth": 1920, "nativeHeight": 1080, "analysisWidth": 640,
            "analysisHeight": 360, "colorSpace": "srgb", "rgbEncoding": "encoded",
            "mapping": "screenAligned", "residualMetric": "linearCameraRgb",
            "screenRoi": [[.1, .1], [.4, .1], [.4, .8], [.1, .8]],
            "bands": [{"bandIndex": 0, "top": .1, "bottom": .5,
                       "targetRgb": [.2, .4, .6], "driveRgb": [.3, .5, .7],
                       "observedRgb": [.1, .3, .5], "residualBefore": .15,
                       "quality": {"status": "accepted", "validPixels": 256,
                                   "validBlocks": 16, "blockSpread": .01, "clippedRate": 0.}}]}


def test_bounded_evidence_snapshot_persists_and_summary_preserves_native_zero_clock(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c)
        base = "/api/sessions/" + s["sessionId"]
        snapshot = evidence_snapshot()
        payload = dict(event(), event="evidence", details={"evidenceSnapshot": snapshot})
        response = c.post(base + "/diagnostics", json={"events": [payload]}, headers=auth(s))
        assert response.status_code == 200, response.text
        summary = c.get(base + "/diagnostics/summary", headers=auth(s)).json()
        assert summary["latestEvidence"]["camera"]["sampled"] == snapshot
        rows = [json.loads(line) for p in (tmp_path / "diagnostics").glob("*.jsonl") for line in p.read_text().splitlines()]
        assert next(row for row in rows if row["event"] == "evidence")["details"]["evidenceSnapshot"] == snapshot
        assert s["cameraToken"] not in json.dumps(rows)
        assert s["displayToken"] not in json.dumps(rows)


@pytest.mark.parametrize("mutate", [
    lambda value, token: value.update(token=token),
    lambda value, token: value.update(patchId=token),
    lambda value, token: value.update(streamId=token),
    lambda value, token: value["bands"][0].update(id=token),
    lambda value, token: value["bands"][0]["quality"].update(message=token),
    lambda value, token: value.update(rejectionReasons=[token]),
    lambda value, token: value.update(bands=value["bands"] * 33),
    lambda value, token: value.update(markerCells=[[.1, .2, .3]] * 29),
    lambda value, token: value.update(screenRoi=[[1.1, .2], [.4, .1], [.4, .8]]),
    lambda value, token: value.update(commandSequence=True),
    lambda value, token: value.update(presentedFrames=1000000001),
    lambda value, token: value.update(rawMediaTime=-1.),
    lambda value, token: value.update(nativeWidth=12001),
    lambda value, token: value["bands"][0].update(residualBefore=2.1),
    lambda value, token: value.update(physicalAccuracyVerified=True),
    lambda value, token: value.update(renderedProof="physicalVerification"),
    lambda value, token: value.update(markerRoi=[[.1, .1]] * 9),
])
def test_nested_evidence_unknown_keys_tokens_and_bounds_fail_closed_without_echo(tmp_path, monkeypatch, mutate):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c)
        snapshot = evidence_snapshot()
        mutate(snapshot, s["cameraToken"])
        payload = dict(event(), event="evidence", details={"evidenceSnapshot": snapshot})
        response = c.post("/api/sessions/" + s["sessionId"] + "/diagnostics", json={"events": [payload]}, headers=auth(s))
        assert response.status_code == 422
        assert s["cameraToken"] not in response.text
        assert s["cameraToken"] not in "".join(p.read_text() for p in (tmp_path / "diagnostics").glob("*.jsonl"))


def test_nested_evidence_cannot_mutate_baseline_events_or_authoritative_server_snapshot(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c)
        url = "/api/sessions/" + s["sessionId"] + "/diagnostics"
        payload = dict(event(), details={"evidenceSnapshot": evidence_snapshot()})
        assert c.post(url, json={"events": [payload]}, headers=auth(s)).status_code == 422
        payload["event"] = "evidence"
        payload["details"]["evidenceSnapshot"]["role"] = "server"
        assert c.post(url, json={"events": [payload]}, headers=auth(s)).status_code == 422


@pytest.mark.parametrize("mutate", [
    lambda value: value.pop("rgbEncoding"),
    lambda value: value.pop("colorSpace"),
    lambda value: value.pop("residualMetric"),
    lambda value: value.update(bands=value["bands"] * 2),
    lambda value: value["bands"][0].update(top=.6, bottom=.5),
])
def test_evidence_domains_metric_and_band_identity_are_explicit(mutate):
    from colorlab.models import DiagnosticEvidence
    from pydantic import ValidationError
    snapshot = evidence_snapshot()
    mutate(snapshot)
    with pytest.raises(ValidationError):
        DiagnosticEvidence.model_validate(snapshot)


def test_marker_rejection_counts_are_controlled_and_persist_exact_reasons(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c)
        url = "/api/sessions/" + s["sessionId"] + "/diagnostics"
        details = {"markerSentinels": 12, "markerRejections": {"ambiguousCells": 4, "nativeSentinelEdges": 2}, "reason": "markerMismatch"}
        response = c.post(url, json={"events": [dict(event(), details=details)]}, headers=auth(s))
        assert response.status_code == 200, response.text
        details["markerRejections"]["token"] = s["cameraToken"]
        response = c.post(url, json={"events": [dict(event(2), details=details)]}, headers=auth(s))
        assert response.status_code == 422
        assert s["cameraToken"] not in response.text


@pytest.mark.parametrize("code", ["capture_frozen_video_clock", "capture_frame_identity_unavailable"])
def test_actual_capture_clock_failure_codes_are_controlled(code):
    from colorlab.models import DiagnosticEvent
    payload = dict(event(), event="operation_error", details={"code": code})
    assert DiagnosticEvent.model_validate(payload).details["code"] == code


def test_display_diagnostics_only_accepts_active_display_render_evidence_and_cannot_control_session(tmp_path, monkeypatch):
    from colorlab.app import create_app
    from test_live_preview import active, preview
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c, "cameraMatch")
        url = "/api/sessions/" + s["sessionId"] + "/diagnostics"
        headers = {**auth(s), "Authorization": "Bearer " + s["displayToken"]}
        payload = dict(event(), event="evidence", details={"evidenceSnapshot": {
            "role": "display", "stage": "rendered", "commandSequence": 1,
            "renderedProof": "twoAnimationFrames", "physicalAccuracyVerified": False,
            "displayDriveRgb": [.4, .5, .6], "renderedPaintRgb": [102 / 255, 128 / 255, 153 / 255],
            "colorSpace": "srgb", "rgbEncoding": "encoded", "status": "renderRequestOnly"}})
        assert c.post(url, json={"events": [payload]}, headers=headers).status_code == 401
        with active(c, s):
            response = c.post(url, json={"events": [payload]}, headers=headers)
            assert response.status_code == 200, response.text
            # Role-local sequence counters prevent A's sequence 1 swallowing B's sequence 1.
            assert c.post(url, json={"events": [dict(event(), event="evidence", details={"evidenceSnapshot": evidence_snapshot()})]}, headers=auth(s)).json()["accepted"] == 1
            assert c.post(url, json={"events": [payload]}, headers=auth(s)).status_code == 403
            payload["details"]["evidenceSnapshot"]["renderedProof"] = None
            assert c.post(url, json={"events": [payload]}, headers=headers).status_code == 403
            payload["details"]["evidenceSnapshot"]["renderedProof"] = "twoAnimationFrames"
            payload["details"]["evidenceSnapshot"]["role"] = "camera"
            assert c.post(url, json={"events": [payload]}, headers=headers).status_code == 403
            payload["details"]["evidenceSnapshot"]["role"] = "server"
            payload["details"]["evidenceSnapshot"]["stage"] = "feedbackAccepted"
            assert c.post(url, json={"events": [payload]}, headers=headers).status_code == 422
            assert c.post(url, json={"events": [event()]}, headers=headers).status_code == 403
            summary = c.get(url + "/summary", headers=auth(s)).json()
            assert "display" in summary["latestEvidence"]
            assert "server" not in summary["latestEvidence"]
            assert c.get(url + "/summary", headers=headers).status_code == 401
            assert c.patch(url, json={"enabled": False}, headers=headers).status_code == 401
            assert c.post("/api/sessions/" + s["sessionId"] + "/live-preview", json=preview(), headers=headers).status_code == 401


def test_server_evidence_separates_native_target_and_css_drive_domains(tmp_path, monkeypatch):
    from colorlab.app import create_app
    from test_live_preview import active, preview
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c, "cameraMatch")
        base = "/api/sessions/" + s["sessionId"]
        with active(c, s) as (camera, display):
            body = preview()
            body["cameraAppearanceColorSpace"] = "display-p3"
            assert c.post(base + "/live-preview", json=body, headers=auth(s)).status_code == 200
            camera.receive_json(); display.receive_json()
            evidence = c.get(base + "/diagnostics/summary", headers=auth(s)).json()["latestEvidence"]["server"]["intended"]
            assert evidence["targetColorSpace"] == "display-p3"
            assert evidence["driveColorSpace"] == "srgb"
            assert "observedColorSpace" not in evidence


def test_unknown_nested_key_cannot_echo_a_token_in_validation_locations(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c)
        snapshot = evidence_snapshot()
        snapshot["bands"][0][s["cameraToken"]] = 1
        payload = dict(event(), event="evidence", details={"evidenceSnapshot": snapshot})
        response = c.post("/api/sessions/" + s["sessionId"] + "/diagnostics", json={"events": [payload]}, headers=auth(s))
        assert response.status_code == 422
        assert s["cameraToken"] not in response.text


def test_camera_diagnostics_consent_change_notifies_both_owned_devices(tmp_path, monkeypatch):
    from colorlab.app import create_app
    from test_live_preview import active
    import importlib
    module = importlib.import_module("colorlab.app")
    emitted = []
    original_emit = module.emit
    async def record(s, name, payload):
        emitted.append((name, payload))
        await original_emit(s, name, payload)
    monkeypatch.setattr(module, "emit", record)
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            response = c.patch("/api/sessions/" + s["sessionId"] + "/diagnostics", json={"enabled": False}, headers=auth(s))
            assert response.status_code == 200
            assert any(name == "session.state" and payload["diagnosticsEnabled"] is False for name, payload in emitted)
            for socket in (camera, display):
                envelope = socket.receive_json()
                assert envelope["event"] == "session.state"
                assert envelope["payload"]["diagnosticsEnabled"] is False


def test_server_preview_acceptance_records_target_drive_and_measured_residual_without_client_trace(tmp_path, monkeypatch):
    from colorlab.app import create_app
    from test_live_preview import active, preview
    from test_preview_feedback import feedback, acknowledge
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c, "cameraMatch")
        base = "/api/sessions/" + s["sessionId"]
        with active(c, s) as (camera, display):
            body = preview()
            body.update(fingerprint="stable", canvasColorSpace="srgb")
            body["sourceFrame"]["mediaTime"] = 0.
            patch = c.post(base + "/live-preview", json=body, headers=auth(s)).json()
            camera.receive_json(); display.receive_json()
            acknowledge(camera, display, s, patch, 2)
            c.app.state.sessions[s["sessionId"]]["previewIssuedAt"] = 0
            measured = preview(2)
            measured.update(fingerprint="stable", canvasColorSpace="srgb", feedback=feedback(patch, [.1, .2, .3]))
            measured["sourceFrame"]["mediaTime"] = 0.
            response = c.post(base + "/live-preview", json=measured, headers=auth(s))
            assert response.status_code == 200, response.text
            camera.receive_json(); display.receive_json()
            evidence = c.get(base + "/diagnostics/summary", headers=auth(s)).json()["latestEvidence"]["server"]["feedbackAccepted"]
            assert evidence["rawMediaTime"] == 0
            assert evidence["commandSequence"] == response.json()["commandSequence"]
            assert evidence["observedCommandSequence"] == patch["commandSequence"]
            assert evidence["bands"][0]["targetRgb"] == measured["bands"][0]["drive"]
            assert evidence["bands"][0]["driveRgb"] == response.json()["bands"][0]["drive"]
            assert evidence["bands"][0]["observedRgb"] == measured["feedback"]["screenAppearanceBands"][0]["rgb"]
            assert evidence["bands"][0]["residualBefore"] == response.json()["compensation"]["perBand"][0]["residualBefore"]
            text = "".join(p.read_text() for p in (tmp_path / "diagnostics").glob("*.jsonl"))
            assert '"previewAccepted"' in text
            for private in (s["cameraToken"], s["displayToken"], patch["patchId"], body["streamId"]):
                assert private not in text


def test_automatic_private_log_persists_without_download_and_exposes_only_public_id(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c, "cameraMatch")
        assert s["diagnosticsEnabled"] is True
        assert len(s["diagnosticId"]) >= 16
        url = "/api/sessions/" + s["sessionId"]
        response = c.post(url + "/diagnostics", json={"events": [event()]}, headers=auth(s))
        assert response.status_code == 200, response.text
        assert response.json()["lastClientSequence"] == 1
        assert len(response.headers["x-request-id"]) >= 16
        path = tmp_path / "diagnostics" / (hashlib.sha256(s["diagnosticId"].encode()).hexdigest() + ".jsonl")
        assert path.is_file()
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        assert any(row["area"] == "tracking" and row["event"] == "geometry" for row in rows)
        text = path.read_text()
        assert s["cameraToken"] not in text
        assert s["displayToken"] not in text
        assert s["sessionId"] not in text
        assert path.stat().st_mode & 0o777 == 0o600
        assert path.parent.stat().st_mode & 0o777 == 0o700
        summary = c.get(url + "/diagnostics/summary", headers=auth(s)).json()
        assert summary["diagnosticId"] == s["diagnosticId"]
        assert summary["containsImages"] is False
        assert str(tmp_path) not in json.dumps(summary)
        assert c.get(url, headers=auth(s)).json()["diagnosticId"] == s["diagnosticId"]
        c.app.state.sessions[s["sessionId"]]["expiry"] = 0
        assert c.get(url + "/diagnostics/summary", headers=auth(s)).status_code == 401
        assert path.is_file()
    assert path.is_file()


@pytest.mark.parametrize("details", [
    {"token": "secret"}, {"deviceLabel": "phone"}, {"message": "free secret"},
    {"pixels": [[1., 0., 0.]]}, {"evidence": {"secret": "hidden"}},
    {"width": True}, {"width": "640"}, {"code": "secret-internal-error"},
    {"reason": "bearer-secret"}, {"endpoint": "/api/sessions/secret"},
])
def test_private_or_uncontrolled_diagnostic_fields_rejected(tmp_path, monkeypatch, details):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c)
        payload = event()
        payload["details"] = details
        response = c.post("/api/sessions/" + s["sessionId"] + "/diagnostics", json={"events": [payload]}, headers=auth(s))
        assert response.status_code == 422
        assert "secret" not in response.text
        assert "secret" not in "".join(p.read_text() for p in (tmp_path / "diagnostics").glob("*.jsonl"))


def test_diagnostics_bounded_batch_body_sequence_retry_disable_and_explicit_delete(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c)
        base = "/api/sessions/" + s["sessionId"]
        url = base + "/diagnostics"
        assert c.post(url, json={"events": [event()] * 101}, headers=auth(s)).status_code == 422
        oversized = json.dumps({"events": [event()]}).encode() + b" " * 65536
        assert c.post(url, content=oversized, headers={**auth(s), "Content-Type": "application/json"}).status_code == 413
        assert c.post(url, json={"events": [event(2), event(1)]}, headers=auth(s)).status_code == 409
        assert c.post(url, json={"events": [event(1), event(2)]}, headers=auth(s)).status_code == 200
        # Retrying an acknowledged batch must not write duplicate rows.
        assert c.post(url, json={"events": [event(1), event(2)]}, headers=auth(s)).status_code == 200
        assert c.get(url + "/summary", headers=auth(s)).json()["receivedEvents"] == 2
        assert c.patch(url, json={"enabled": False}, headers=auth(s)).json()["enabled"] is False
        before = [p.read_bytes() for p in (tmp_path / "diagnostics").glob("*.jsonl")]
        assert c.post(url, json={"events": [event(3)]}, headers=auth(s)).status_code == 409
        assert c.get(base, headers=auth(s)).json()["diagnosticsEnabled"] is False
        assert [p.read_bytes() for p in (tmp_path / "diagnostics").glob("*.jsonl")] == before
        assert c.delete(base, headers=auth(s)).status_code == 200
        assert list((tmp_path / "diagnostics").glob("*.jsonl")) == []


def test_diagnostics_camera_bearer_origin_no_private_path_static_access(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c)
        url = "/api/sessions/" + s["sessionId"] + "/diagnostics"
        assert c.post(url, json={"events": [event()]}, headers={**auth(s), "Authorization": "Bearer " + s["displayToken"]}).status_code == 401
        assert c.post(url, json={"events": [event()]}, headers={**auth(s), "Origin": "https://evil.test"}).status_code == 403
        assert c.post(url, json={"events": [event()]}, headers={"Authorization": auth(s)["Authorization"]}).status_code == 403
        assert c.get(url + "/summary").status_code == 401
        assert c.get("/data/diagnostics/" + hashlib.sha256(s["diagnosticId"].encode()).hexdigest() + ".jsonl").status_code == 404


def test_diagnostics_store_file_tail_and_global_quota(tmp_path):
    from colorlab.diagnostics import DiagnosticsStore
    store = DiagnosticsStore(tmp_path / "diagnostics", file_limit=1200, total_limit=2400)
    for i in range(80):
        store.append("test-one", [event(i + 1)])
    path = store.path("test-one")
    assert path.stat().st_size <= 1200
    assert json.loads(path.read_text().splitlines()[-1])["sequence"] == 80
    for i in range(8):
        store.append(f"test-{i}", [event(j + 1) for j in range(10)])
    assert sum(p.stat().st_size for p in store.directory.glob("*.jsonl")) <= 2400
    assert store.path("test-7").is_file()


def test_server_request_diagnostics_use_request_id_class_status_not_body_header_or_id(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c)
        url = "/api/sessions/" + s["sessionId"] + "/conditions"
        response = c.patch(url, json={"conditions": {"label": "private-user-body"}}, headers={**auth(s), "Cookie": "private-cookie"})
        assert response.status_code == 200
        rows = [json.loads(line) for p in (tmp_path / "diagnostics").glob("*.jsonl") for line in p.read_text().splitlines()]
        request_row = next(row for row in rows if row.get("requestId") == response.headers["x-request-id"])
        assert request_row["event"] == "response"
        assert request_row["details"]["endpoint"] == "conditions"
        assert request_row["details"]["status"] == 200
        text = json.dumps(rows)
        assert "private-user-body" not in text
        assert "private-cookie" not in text
        assert s["sessionId"] not in text


def test_default_disabled_session_does_not_create_software_logs(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = c.post("/api/sessions", json={"mode": "replay", "conditions": {}, "diagnosticsEnabled": False}, headers={"Origin": "http://localhost:8443"}).json()
        c.get("/api/sessions/" + s["sessionId"], headers=auth(s))
        assert not (tmp_path / "diagnostics").exists()


def test_server_pause_and_render_logs_controlled_events_never_arbitrary_reasons(tmp_path, monkeypatch):
    from colorlab.app import create_app
    from colorlab.protocol import pause
    from test_live_preview import active, preview
    from test_protocol import message
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            patch = c.post("/api/sessions/" + s["sessionId"] + "/live-preview", json=preview(), headers=auth(s)).json()
            camera.receive_json(); display.receive_json()
            display.send_json(message(s, "display", "display.patch.rendered", {"profileVersion": 0,
                "patchId": patch["patchId"], "commandSequence": patch["commandSequence"], "renderedAt": 1.}, 2))
            camera.receive_json(); display.receive_json()
            pause(c.app.state.sessions[s["sessionId"]], "private-secret-reason")
        rows = [json.loads(line) for p in (tmp_path / "diagnostics").glob("*.jsonl") for line in p.read_text().splitlines()]
        assert any(row["event"] == "display.patch.rendered" for row in rows)
        assert any(row["event"] == "pause" and row["details"]["reason"] == "unclassified" for row in rows)
        assert "private-secret-reason" not in json.dumps(rows)


def test_diagnostics_storage_failure_returns_safe_code_without_private_paths(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c)
        def unavailable(*args):
            raise OSError("secret server path /home/private")
        monkeypatch.setattr(c.app.state.diagnostics, "append", unavailable)
        url = "/api/sessions/" + s["sessionId"]
        response = c.post(url + "/diagnostics", json={"events": [event()]}, headers=auth(s))
        assert response.status_code == 503
        assert response.json()["detail"] == "diagnostics_storage_unavailable"
        assert "private" not in response.text
        assert c.get(url, headers=auth(s)).status_code == 200


def test_controlled_client_preview_events_accepted_and_timestamp_not_free_text(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        s = new_session(c)
        url = "/api/sessions/" + s["sessionId"] + "/diagnostics"
        rows = [dict(event(i + 1), event=name) for i, name in enumerate(("previewOpened", "captureStarted"))]
        response = c.post(url, json={"events": rows}, headers=auth(s))
        assert response.status_code == 200, response.text
        assert response.json()["accepted"] == 2
        assert c.post(url, json={"events": rows}, headers=auth(s)).json()["accepted"] == 0
