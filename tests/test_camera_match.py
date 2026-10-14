"""Synthetic live camera-domain evidence, never hardware/calibration validation."""
from contextlib import contextmanager
import pytest

from test_api import auth, client, frames, new_session, physical_batch
from test_protocol import join, message


def target_body(number=1, value=.4):
    captured = physical_batch(frames(f"target-{number}", value), number, 1)
    for frame in captured:
        frame["exclusions"] = []
    region = {"id": "roi-1", "label": "automatic fabric", "order": 0, "mode": "solid",
              "polygon": captured[0]["roi"], "exclusions": [], "background": None,
              "layers": None, "direction": None, "operatorConfirmed": False,
              "selectionMethod": "autoDetected"}
    return {"region": region, "frames": captured, "sourceColorSpace": "srgb",
            "sourceCaptureIds": [f["id"] for f in captured], "capturedAt": "2026-10-13T18:45:00Z"}


@contextmanager
def active(c, session):
    path = "/ws/" + session["sessionId"]
    with c.websocket_connect(path, headers=auth(session)) as camera:
        join(camera, session, "camera")
        with c.websocket_connect(path, headers=auth(session)) as display:
            join(display, session, "display")
            camera.send_json(message(session, "camera", "session.resume", {"witnessChecked": True}, 2))
            assert camera.receive_json()["payload"]["paused"] is False
            assert display.receive_json()["payload"]["paused"] is False
            yield camera, display


def test_camera_match_explicit_session_without_forged_profiles():
    with client() as c:
        session = new_session(c, "cameraMatch")
        assert session["state"] == "fabric"
        snapshot = c.get("/api/sessions/" + session["sessionId"], headers=auth(session)).json()
        assert snapshot["mode"] == "cameraMatch"
        assert snapshot["cameraProfile"] is None
        assert snapshot["displayProfile"] is None
        assert snapshot["references"] is None
        from colorlab.models import Session
        Session.model_validate(snapshot)


def observation(run, number, value=.4):
    sequence = run["commandSequence"]
    marker = [[float(bit)] * 3 for bit in [0, 1, 0, 1] + [int(x) for x in f"{sequence:024b}"]]
    screen = physical_batch(frames(f"screen-{number}", value), number, 0)
    fabric = physical_batch(frames(f"fabric-{number}", value), number, 1)
    for frame in screen + fabric:
        frame.update(markerSequence=sequence, markerPixels=marker, exclusions=[])
    return {"frames": screen, "fabricFrames": fabric, "markerSequence": sequence,
            "commandSequence": sequence, "patchId": run["patchId"], "stable": True, "layout": "single"}


def render(camera, display, session, run, sequence):
    display.send_json(message(session, "display", "display.patch.rendered", {
        "profileVersion": 0, "patchId": run["patchId"],
        "commandSequence": run["commandSequence"], "renderedAt": float(sequence)}, sequence))
    assert camera.receive_json()["event"] == "display.patch.rendered"
    assert display.receive_json()["event"] == "display.patch.rendered"


def drain_start(camera, display):
    for ws in (camera, display):
        assert ws.receive_json()["event"] == "measurement.submit"
        assert ws.receive_json()["event"] == "display.patch.set"
        assert ws.receive_json()["event"] == "capture.request"


def test_camera_match_real_engine_three_fresh_batches_and_catalog_null():
    with client() as c:
        session = new_session(c, "cameraMatch")
        base = "/api/sessions/" + session["sessionId"]
        with active(c, session) as (camera, display):
            started = c.post(base + "/camera-matches", json=target_body(), headers=auth(session))
            assert started.status_code == 200, started.text
            run = started.json()
            from colorlab.models import MatchRun, Measurement
            MatchRun.model_validate(run)
            assert run["nextDrive"] == pytest.approx([.4] * 3)
            drain_start(camera, display)
            observe_url = base + "/camera-matches/" + run["runId"] + "/observe"
            for index in range(3):
                body = observation(run, index + 2)
                assert c.post(observe_url, json=body, headers=auth(session)).status_code == 409
                render(camera, display, session, run, index + 2)
                response = c.post(observe_url, json=body, headers=auth(session))
                assert response.status_code == 200, response.text
                output = response.json()
                MatchRun.model_validate(output)
                assert output["iterations"] == index + 1
                if index < 2:
                    assert output["status"] == "running"
                    assert output["nextDrive"] == run["nextDrive"]
                    assert output["commandSequence"] > run["commandSequence"]
                    for ws in (camera, display):
                        assert ws.receive_json()["event"] == "display.patch.set"
                        assert ws.receive_json()["event"] == "match.iteration"
                else:
                    assert output["status"] == "complete"
                    assert output["terminationReason"] == "tolerance"
                    assert output["objectiveValue"] == pytest.approx(0.)
                    for ws in (camera, display):
                        assert ws.receive_json()["event"] == "match.complete"
                run = output
            assert c.post(observe_url, json=body, headers=auth(session)).status_code == 409
            for kind in ("experimental", "approved"):
                report = c.get(base + "/export?kind=" + kind, headers=auth(session)).json()
                assert report["status"] == "exploratoryCameraMatch"
                assert report["cameraProfile"] is None
                assert report["displayProfile"] is None
                sample = report["measurements"][0]
                Measurement.model_validate(sample)
                assert sample["id"] == started.json()["measurementId"]
                assert sample["catalogStatus"] == "exploratory"
                assert sample["catalogColor"] is None
                assert sample["catalogHexSrgb"] is None
                assert sample["displayDriveRgb"] == pytest.approx([.4] * 3)
                assert sample["independentValidationStatus"] == "notTested"
                assert sample["approved"] is False
                assert sample["instrumentDeltaE00"] is None
                assert "noVerifiedPhysicalReference" in sample["approvalLimitations"]


def test_camera_match_cannot_enter_calibrated_or_manual_catalog_routes():
    with client() as c:
        session = new_session(c, "cameraMatch")
        base = "/api/sessions/" + session["sessionId"]
        headers = auth(session)
        assert c.post(base + "/reference", json={"exploratory": True}, headers=headers).status_code == 409
        assert c.post(base + "/camera-profile", json={"observations": [], "fingerprint": "settings-1"}, headers=headers).status_code == 409
        with active(c, session) as (camera, display):
            run = c.post(base + "/camera-matches", json=target_body(), headers=headers).json()
            drain_start(camera, display)
            assert c.post(base + "/measurements/" + run["measurementId"] + "/override",
                          json={"catalogHexSrgb": "#ABCDEF", "reason": "manual"}, headers=headers).status_code == 409
            assert c.get(base, headers=headers).json()["cameraProfile"] is None


def test_camera_match_requires_explicit_mode_ownership_resume_and_strict_body():
    with client() as c:
        wrong = new_session(c)
        session = new_session(c, "cameraMatch")
        base = "/api/sessions/" + session["sessionId"]
        headers = auth(session)
        url = base + "/camera-matches"
        assert c.post("/api/sessions/" + wrong["sessionId"] + "/camera-matches", json=target_body(), headers=auth(wrong)).status_code == 409
        assert c.post(url, json=target_body(), headers=headers).status_code == 409
        assert c.post(url, json=target_body(), headers=auth(wrong)).status_code == 401
        assert c.post(url, json=target_body(), headers={**headers, "Authorization": "Bearer " + session["displayToken"]}).status_code == 401
        with c.websocket_connect("/ws/" + session["sessionId"], headers=headers) as camera:
            join(camera, session, "camera")
            camera.send_json(message(session, "camera", "session.resume", {"witnessChecked": True}, 2))
            camera.receive_json()
            assert c.post(url, json=target_body(), headers=headers).status_code == 409
        with active(c, session) as (camera, display):
            for extra in ({"maxEvaluations": 41}, {"targetRgb": [.4] * 3}, {"approved": True}, {"cameraProfile": {}}, {"noiseFloor": True}):
                assert c.post(url, json={**target_body(), **extra}, headers=headers).status_code == 422
            camera.send_json(message(session, "camera", "session.pause", {"reason": "manual pause"}, 3))
            camera.receive_json()
            display.receive_json()
            assert c.post(url, json=target_body(), headers=headers).status_code == 409


def test_camera_match_target_provenance_quality_and_reuse_are_required():
    with client() as c:
        session = new_session(c, "cameraMatch")
        base = "/api/sessions/" + session["sessionId"]
        with active(c, session) as (camera, display):
            url = base + "/camera-matches"
            mutations = [lambda b: b["sourceCaptureIds"].reverse(),
                         lambda b: b.update(sourceColorSpace="display-p3"),
                         lambda b: b["frames"][0].pop("mediaTime"),
                         lambda b: b["frames"][0].update(source="replay"),
                         lambda b: b["frames"][0].update(regionId="other"),
                         lambda b: b["frames"][0].update(width=320),
                         lambda b: b["frames"][0].update(exclusions=None),
                         lambda b: b["frames"].pop(),
                         lambda b: b["frames"][0].update(settingsFingerprint="changed")]
            for change in mutations:
                body = target_body()
                change(body)
                response = c.post(url, json=body, headers=auth(session))
                assert response.status_code in (409, 422), response.text
            assert c.post(url, json=target_body(value=1.), headers=auth(session)).status_code == 422
            assert c.get(base, headers=auth(session)).json()["measurements"] == []
            started = c.post(url, json={**target_body(), "maxEvaluations": 1}, headers=auth(session))
            assert started.status_code == 200, started.text
            run = started.json()
            drain_start(camera, display)
            assert c.post(url, json=target_body(8), headers=auth(session)).status_code == 409
            render(camera, display, session, run, 2)
            response = c.post(url + "/" + run["runId"] + "/observe", json=observation(run, 2), headers=auth(session))
            assert response.json()["status"] == "stopped"
            assert response.json()["terminationReason"] == "evaluation-budget"
            for ws in (camera, display):
                ws.receive_json()
            reused = target_body()
            for frame in reused["frames"]:
                frame["id"] += "-renamed"
            reused["sourceCaptureIds"] = [f["id"] for f in reused["frames"]]
            assert c.post(url, json=reused, headers=auth(session)).status_code == 409


def test_camera_match_observe_rejects_forged_stale_unpaired_overlapping_and_changed_evidence():
    with client() as c:
        session = new_session(c, "cameraMatch")
        base = "/api/sessions/" + session["sessionId"]
        headers = auth(session)
        with active(c, session) as (camera, display):
            run = c.post(base + "/camera-matches", json=target_body(), headers=headers).json()
            drain_start(camera, display)
            url = base + "/camera-matches/" + run["runId"] + "/observe"
            render(camera, display, session, run, 2)
            mutations = [lambda b: b.update(stable=False),
                         lambda b: b.update(commandSequence=999),
                         lambda b: b.update(patchId="forged"),
                         lambda b: b.update(markerSequence=999),
                         lambda b: b.update(layout="group"),
                         lambda b: b.update(finalRgb=[.4] * 3),
                         lambda b: b.update(status="complete"),
                         lambda b: b.pop("fabricFrames"),
                         lambda b: b["frames"][0].update(markerPixels=None),
                         lambda b: b["fabricFrames"][0].update(markerPixels=[[.5] * 3] * 28),
                         lambda b: b["fabricFrames"][4].update(mediaTime=123.),
                         lambda b: b["fabricFrames"][4].update(capturedAt=99999.),
                         lambda b: b["frames"][0].update(settingsFingerprint="changed"),
                         lambda b: b["frames"][0].pop("presentedFrames"),
                         lambda b: b["frames"][0].update(width=320),
                         lambda b: b["frames"][0].update(source="replay")]
            for change in mutations:
                body = observation(run, 2)
                change(body)
                response = c.post(url, json=body, headers=headers)
                assert response.status_code in (409, 422), response.text
            overlapping = observation(run, 2)
            for f in overlapping["frames"]:
                f.update(roi=overlapping["fabricFrames"][0]["roi"], regionId="renamed-overlap")
            assert c.post(url, json=overlapping, headers=headers).status_code == 409
            clipped = observation(run, 2)
            for f in clipped["frames"]:
                f["pixels"] = [[1.] * 3] * 16
            assert c.post(url, json=clipped, headers=headers).status_code == 422
            response = c.post(url, json=observation(run, 2), headers=headers)
            assert response.status_code == 200, response.text
            previous = run
            run = response.json()
            for ws in (camera, display):
                ws.receive_json()
                ws.receive_json()
            assert c.post(url, json=observation(previous, 3), headers=headers).status_code == 409
            render(camera, display, session, run, 3)
            assert c.post(url, json=observation(run, 2), headers=headers).status_code == 409
            changed_roi = observation(run, 3)
            for f in changed_roi["frames"]:
                f.update(roi=[[.05, .1], [.15, .1], [.15, .2], [.05, .2]])
            assert c.post(url, json=changed_roi, headers=headers).status_code == 422
            changed_fabric = observation(run, 3)
            for f in changed_fabric["fabricFrames"]:
                f.update(roi=[[.25, .1], [.35, .1], [.35, .2], [.25, .2]])
            assert c.post(url, json=changed_fabric, headers=headers).status_code == 422
            assert c.get(base, headers=headers).json()["measurements"][0]["displayDriveRgb"] is None


def test_camera_match_fabric_drift_pauses_clears_run_without_completing():
    with client() as c:
        session = new_session(c, "cameraMatch")
        base = "/api/sessions/" + session["sessionId"]
        with active(c, session) as (camera, display):
            run = c.post(base + "/camera-matches", json=target_body(), headers=auth(session)).json()
            drain_start(camera, display)
            render(camera, display, session, run, 2)
            body = observation(run, 2)
            for f in body["fabricFrames"]:
                f["pixels"] = [[.6] * 3] * 16
            url = base + "/camera-matches/" + run["runId"] + "/observe"
            response = c.post(url, json=body, headers=auth(session))
            assert response.status_code == 422
            assert response.json()["detail"] == "fabric_target_drift"
            for ws in (camera, display):
                assert ws.receive_json()["event"] == "session.state"
            snapshot = c.get(base, headers=auth(session)).json()
            assert snapshot["paused"]
            assert snapshot["pauseReason"] == "fabric_target_drift"
            assert snapshot["currentPatch"] is None
            assert snapshot["measurements"][0]["displayDriveRgb"] is None
            assert c.post(url, json=observation(run, 3), headers=auth(session)).status_code == 409


def test_camera_match_pause_disconnect_invalidation_clear_server_run():
    with client() as c:
        session = new_session(c, "cameraMatch")
        base = "/api/sessions/" + session["sessionId"]
        with active(c, session) as (camera, display):
            run = c.post(base + "/camera-matches", json=target_body(), headers=auth(session)).json()
            drain_start(camera, display)
            camera.send_json(message(session, "camera", "session.pause", {"reason": "paused"}, 3))
            camera.receive_json()
            display.receive_json()
            assert c.post(base + "/camera-matches/" + run["runId"] + "/observe", json=observation(run, 2), headers=auth(session)).status_code == 409
            assert c.app.state.sessions[session["sessionId"]]["runs"] == {}
        assert c.get(base, headers=auth(session)).json()["paused"]
        with active(c, session) as (camera, display):
            run = c.post(base + "/camera-matches", json=target_body(10), headers=auth(session)).json()
            drain_start(camera, display)
            changed = c.patch(base + "/conditions", json={"conditions": {"light": "changed"}}, headers=auth(session))
            assert changed.status_code == 200
            assert changed.json()["state"] == "fabric"
            assert changed.json()["cameraProfile"] is None
            assert c.post(base + "/camera-matches/" + run["runId"] + "/observe", json=observation(run, 11), headers=auth(session)).status_code == 409


def test_camera_match_never_exceeds_forty_engine_evaluations_or_trusts_completion():
    from colorlab.app import create_app
    from fastapi.testclient import TestClient
    with TestClient(create_app(request_rate=120)) as c:
        session = new_session(c, "cameraMatch")
        base = "/api/sessions/" + session["sessionId"]
        with active(c, session) as (camera, display):
            run = c.post(base + "/camera-matches", json={**target_body(), "maxEvaluations": 40}, headers=auth(session)).json()
            drain_start(camera, display)
            url = base + "/camera-matches/" + run["runId"] + "/observe"
            for index in range(40):
                # Respect the real transport's 20-message/sec rate limit.
                import time
                time.sleep(.06)
                render(camera, display, session, run, index + 2)
                body = observation(run, index + 2)
                for frame in body["frames"]:
                    frame["pixels"] = [[.6] * 3] * 16
                response = c.post(url, json=body, headers=auth(session))
                assert response.status_code == 200, response.text
                run = response.json()
                assert run["iterations"] == index + 1
                if run["nextDrive"] is None:
                    for ws in (camera, display):
                        assert ws.receive_json()["event"] == "match.complete"
                    break
                for ws in (camera, display):
                    assert ws.receive_json()["event"] == "display.patch.set"
                    assert ws.receive_json()["event"] == "match.iteration"
            assert run["status"] == "stopped"
            assert run["iterations"] <= 40
            assert run["terminationReason"] in ("evaluation-budget", "noise-floor")
            assert c.post(url, json=body, headers=auth(session)).status_code == 409
            m = c.get(base, headers=auth(session)).json()["measurements"][0]
            assert m["displayDriveRgb"] == run["bestDrive"]
            assert m["catalogHexSrgb"] is None
            assert m["approved"] is False


def test_camera_match_invalidation_during_summary_cannot_commit_stale_run(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    import colorlab.engine as engine
    entered, release = threading.Event(), threading.Event()
    real = engine.summarize_frames

    def delayed(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return real(*args, **kwargs)

    monkeypatch.setattr(engine, "summarize_frames", delayed)
    with client() as c:
        session = new_session(c, "cameraMatch")
        base = "/api/sessions/" + session["sessionId"]
        with active(c, session):
            with ThreadPoolExecutor() as pool:
                pending = pool.submit(c.post, base + "/camera-matches", json=target_body(), headers=auth(session))
                assert entered.wait(3)
                assert c.patch(base + "/conditions", json={"conditions": {"lighting": "changed"}}, headers=auth(session)).status_code == 200
                release.set()
                assert pending.result().status_code == 409
            snapshot = c.get(base, headers=auth(session)).json()
            assert snapshot["measurements"] == []
            assert snapshot["currentPatch"] is None
            assert c.app.state.sessions[session["sessionId"]]["runs"] == {}


def test_camera_match_expired_superseded_commands_and_disconnect_cannot_finish():
    with client() as c:
        session = new_session(c, "cameraMatch")
        base = "/api/sessions/" + session["sessionId"]
        with active(c, session) as (camera, display):
            run = c.post(base + "/camera-matches", json=target_body(), headers=auth(session)).json()
            drain_start(camera, display)
            render(camera, display, session, run, 2)
            stored = c.app.state.sessions[session["sessionId"]]
            cmd = stored["commands"][run["commandSequence"]]
            cmd["issuedAt"] -= 301
            url = base + "/camera-matches/" + run["runId"] + "/observe"
            assert c.post(url, json=observation(run, 2), headers=auth(session)).json()["detail"] == "command_expired"
            cmd["issuedAt"] += 301
            camera.send_json(message(session, "camera", "display.patch.set", {
                "profileVersion": 0, "patchId": "superseding", "displayDriveRgb": [.8] * 3,
                "layout": "single", "sampleIds": []}, 3))
            camera.receive_json()
            display.receive_json()
            assert c.post(url, json=observation(run, 2), headers=auth(session)).json()["detail"] == "stale_command"
        assert stored["runs"] == {}
        assert stored["commands"] == {}
        assert c.get(base, headers=auth(session)).json()["measurements"][0]["displayDriveRgb"] is None
        with active(c, session):
            assert c.post(url, json=observation(run, 3), headers=auth(session)).status_code == 409
