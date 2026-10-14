import io
import json
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from colorlab.models import LiveDebugMetadata
from test_api import auth, new_session
from test_protocol import join


@pytest.fixture
def debug_client(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as client:
        yield client


def debug_url(session):
    return "/api/sessions/" + session["sessionId"] + "/live-debug"


def camera(client, session):
    ws = client.exit_stack.enter_context(client.websocket_connect(
        "/ws/" + session["sessionId"], headers={"Origin": "http://localhost:8443"}))
    join(ws, session, "camera")
    return ws


def image_bytes(size=(48, 32), format="PNG", **kwargs):
    image = Image.new("RGB", size, (60, 100, 140))
    output = io.BytesIO()
    image.save(output, format=format, **kwargs)
    return output.getvalue()


def start_debug(c, session):
    camera(c, session)
    response = c.post(debug_url(session), json={"enabled": True, "consent": True}, headers=auth(session))
    assert response.status_code == 200, response.text
    return response.json()


def upload(c, session, data=None, metadata=None, filename="../../private.svg", mime="image/png"):
    return c.post(debug_url(session) + "/frames", headers=auth(session),
                  files={"file": (filename, data if data is not None else image_bytes(), mime)},
                  data={"metadata": json.dumps(metadata)} if metadata is not None else {})


def test_explicit_consent_camera_auth_and_paused_handshake(debug_client):
    c = debug_client
    session = new_session(c, "cameraMatch")
    url = debug_url(session)
    headers = auth(session)
    assert c.get(url + "/status", headers=headers).json()["enabled"] is False
    assert c.post(url, json={"enabled": True}, headers=headers).status_code == 400
    assert c.post(url, json={"enabled": True, "consent": False}, headers=headers).status_code == 400
    assert c.post(url, json={"enabled": True, "consent": True}, headers=headers).status_code == 409
    camera(c, session)
    assert c.get(url + "/status").status_code == 401
    display = {**headers, "Authorization": "Bearer " + session["displayToken"]}
    assert c.post(url, json={"enabled": True, "consent": True}, headers=display).status_code == 403
    assert c.get(url + "/status", headers={**headers, "Origin": "https://evil.local"}).status_code == 403
    response = c.post(url, json={"enabled": True, "consent": True}, headers=headers)
    assert response.status_code == 200, response.text
    state = response.json()
    assert state == {
        "enabled": True, "debugId": session["diagnosticId"], "expiresAt": state["expiresAt"],
        "maxFrames": 8, "captureIntervalMs": 3000, "frameCount": 0, "latest": None,
    }
    assert 290 < datetime.fromisoformat(state["expiresAt"]).timestamp() - datetime.now().timestamp() <= 300
    snapshot = c.get("/api/sessions/" + session["sessionId"], headers=headers).json()
    assert snapshot["paused"] is True
    assert snapshot["measurements"] == []
    assert snapshot["currentPatch"] is None
    assert c.post(url, json={"enabled": False}, headers=headers).json()["enabled"] is False


def test_private_canonical_frame_ignores_filename_strips_metadata_and_never_measures(debug_client, tmp_path):
    c = debug_client
    session = new_session(c, "cameraMatch")
    assert upload(c, session).status_code == 409
    start_debug(c, session)
    exif = Image.Exif()
    exif[315] = "private identifying author"
    original = image_bytes(format="JPEG", exif=exif, icc_profile=b"untrusted profile")
    metadata = {"presentedFrames": 100, "mediaTime": 12.5, "width": 1920, "height": 1080,
                "phase": "neutral", "status": "needsFraming", "cardCount": 1,
                "candidateCount": 2, "markerCandidates": 0, "fabricCount": 0,
                "reason": "displayMarkerMissing"}
    response = upload(c, session, original, metadata, mime="image/jpeg")
    assert response.status_code == 200, response.text
    state = response.json()
    assert state["frameCount"] == 1
    assert state["latest"]["metadata"] == metadata
    assert state["latest"]["width"] == 48
    assert state["latest"]["height"] == 32
    assert state["latest"]["colorProvenance"] == "assumedSrgbDiagnosticPreviewNotRawNotMeasurement"
    url = state["latest"]["previewUrl"]
    assert url == debug_url(session) + "/frames/latest"
    assert "private.svg" not in response.text
    assert str(tmp_path) not in response.text
    assert session["cameraToken"] not in response.text
    assert c.get(url).status_code == 401
    assert c.get(url, headers={**auth(session), "Authorization": "Bearer " + session["displayToken"]}).status_code == 403
    preview = c.get(url, headers=auth(session))
    assert preview.status_code == 200
    assert preview.headers["cache-control"] == "no-store"
    assert preview.headers["content-type"] == "image/png"
    canonical = Image.open(io.BytesIO(preview.content))
    assert canonical.format == "PNG"
    assert canonical.mode == "RGB"
    assert canonical.info == {}
    assert not canonical.getexif()
    directory = tmp_path / "live-debug" / session["diagnosticId"]
    assert directory.stat().st_mode & 0o777 == 0o700
    paths = list(directory.glob("*.png"))
    assert len(paths) == 1
    assert paths[0].name == "000001.png"
    assert paths[0].stat().st_mode & 0o777 == 0o600
    assert paths[0].read_bytes() == preview.content
    assert c.get("/data/live-debug/" + session["diagnosticId"] + "/000001.png").status_code == 404
    assert c.get(debug_url(session) + "/frames/000001.png", headers=auth(session)).status_code == 404
    snapshot = c.get("/api/sessions/" + session["sessionId"], headers=auth(session)).json()
    assert snapshot["captures"] == []
    assert snapshot["measurements"] == []
    assert snapshot["currentPatch"] is None
    assert c.get("/api/sessions/" + session["sessionId"] + "/diagnostics/summary", headers=auth(session)).json()["containsImages"] is False
    logs = b"".join(path.read_bytes() for path in (tmp_path / "diagnostics").glob("*.jsonl"))
    assert b"private identifying author" not in logs
    assert b"private.svg" not in logs
    assert b"untrusted profile" not in logs
    assert b"displayMarkerMissing" not in logs


@pytest.mark.parametrize("data,mime,code", [
    (b"not a png", "image/png", 422),
    (image_bytes()[:-20], "image/png", 422),
    (b'<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml", 415),
    (image_bytes(format="GIF"), "image/png", 415),
    (b"x" * (300 * 1024 + 1), "image/png", 413),
    (image_bytes(size=(641, 1)), "image/png", 413),
    (image_bytes(size=(1, 641)), "image/png", 413),
    (image_bytes(size=(641, 640)), "image/png", 413),
], ids=["corrupt", "truncated", "svg", "gif", "bytes", "wide", "tall", "pixels"])
def test_image_decode_format_byte_and_pixel_bounds(debug_client, tmp_path, data, mime, code):
    c = debug_client
    session = new_session(c, "cameraMatch")
    start_debug(c, session)
    response = upload(c, session, data, mime=mime)
    assert response.status_code == code, response.text
    assert not list(tmp_path.glob("live-debug/*/*.png"))
    assert c.get(debug_url(session) + "/status", headers=auth(session)).json()["frameCount"] == 0


def test_image_maximum_dimensions_and_request_envelope(debug_client):
    c = debug_client
    session = new_session(c, "cameraMatch")
    start_debug(c, session)
    assert upload(c, session, image_bytes(size=(640, 640))).status_code == 200
    assert c.post(debug_url(session) + "/frames", headers=auth(session),
                  content=b"x" * (300 * 1024 + 16 * 1024 + 1)).status_code == 413


@pytest.mark.parametrize("metadata", [
    {"token": "private"}, {"presentedFrames": True}, {"width": "640"},
    {"candidateCount": -1}, {"markerCandidates": [1, 2]}, {"mediaTime": float("nan")},
    {"reason": "private arbitrary text"}, {"phase": "https://private.local"},
    {"status": "private diagnostic secret"},
])
def test_metadata_scalar_allowlist_rejects_private_or_invalid_fields(debug_client, metadata):
    c = debug_client
    session = new_session(c, "cameraMatch")
    start_debug(c, session)
    response = upload(c, session, metadata=metadata)
    assert response.status_code == 422, response.text
    assert c.get(debug_url(session) + "/status", headers=auth(session)).json()["frameCount"] == 0


@pytest.mark.parametrize("matched", [True, False], ids=["same-frame", "capture-11-tracking-10"])
def test_debug_metadata_preserves_separate_frame_identity_and_raw_zero(debug_client, matched):
    session = new_session(debug_client, "cameraMatch")
    start_debug(debug_client, session)
    metadata = {"presentedFrames": 10 if matched else 11, "mediaTime": 0.,
                "trackingPresentedFrames": 10, "trackingRawMediaTime": 0.,
                "trackingMatchedFrame": matched, "width": 1920, "height": 1080,
                "imageWidth": 640, "imageHeight": 360}
    if matched:
        metadata.update(phase="neutral", status="ready", cardCount=0,
                        candidateCount=0, markerCandidates=0, fabricCount=0)
    response = upload(debug_client, session, image_bytes(size=(640, 360)), metadata)
    assert response.status_code == 200, response.text
    assert response.json()["latest"]["metadata"] == metadata
    assert response.json()["latest"]["width"] == 640
    assert response.json()["latest"]["height"] == 360


@pytest.mark.parametrize("change", [
    {"trackingPresentedFrames": 9}, {"trackingRawMediaTime": .1},
    {"trackingPresentedFrames": None}, {"trackingRawMediaTime": None},
])
def test_debug_metadata_same_frame_requires_matching_count_and_raw_time(change):
    metadata = {"presentedFrames": 10, "mediaTime": 0., "trackingPresentedFrames": 10,
                "trackingRawMediaTime": 0., "trackingMatchedFrame": True}
    with pytest.raises(ValidationError, match="live_debug_tracking_frame_mismatch"):
        LiveDebugMetadata.model_validate({**metadata, **change})


@pytest.mark.parametrize("field,value", [
    ("phase", "neutral"), ("status", "ready"), ("cardCount", 0),
    ("candidateCount", 0), ("markerCandidates", 0), ("fabricCount", 0),
])
def test_debug_metadata_uncorrelated_frame_forbids_old_tracking_results(field, value):
    with pytest.raises(ValidationError, match="live_debug_uncorrelated_tracking_results"):
        LiveDebugMetadata.model_validate({"trackingMatchedFrame": False, field: value})


@pytest.mark.parametrize("field,value", [
    ("trackingPresentedFrames", True), ("trackingPresentedFrames", -1),
    ("trackingPresentedFrames", 1000000001), ("trackingRawMediaTime", -1.),
    ("trackingRawMediaTime", float("nan")), ("trackingRawMediaTime", float("inf")),
    ("trackingRawMediaTime", 1e12 + 1), ("trackingMatchedFrame", 1),
    ("imageWidth", True), ("imageWidth", 0), ("imageWidth", 641),
    ("imageHeight", 641), ("width", 12001), ("height", 0),
])
def test_debug_metadata_correlation_fields_are_strict_finite_and_bounded(field, value):
    with pytest.raises(ValidationError):
        LiveDebugMetadata.model_validate({field: value})


def test_multipart_duplicate_unknown_fields_and_duplicate_json_keys(debug_client):
    c = debug_client
    session = new_session(c, "cameraMatch")
    start_debug(c, session)
    url = debug_url(session) + "/frames"
    good_file = ("sample.png", image_bytes(), "image/png")
    for fields in ([('file', good_file), ('file', good_file)],
                   [('file', good_file), ('extra', (None, 'private'))],
                   [('file', good_file), ('metadata', (None, '{}')), ('metadata', (None, '{}'))],
                   [('file', good_file), ('metadata', (None, '{"cardCount":1,"cardCount":2}'))]):
        assert c.post(url, headers=auth(session), files=fields).status_code == 422
    assert c.get(url + "/latest", headers=auth(session)).status_code == 404


class Clock:
    def __init__(self):
        import time
        self.now = time.time()

    def __call__(self):
        return self.now

    def advance(self, seconds=3):
        self.now += seconds


def test_capture_rate_actual_frame_counter_and_immutable_latest_metadata(debug_client):
    c = debug_client
    clock = Clock()
    c.app.state.live_debug.clock = clock
    session = new_session(c, "cameraMatch")
    state = start_debug(c, session)
    first = upload(c, session, metadata={"presentedFrames": 0, "mediaTime": 0.})
    assert first.status_code == 200
    assert upload(c, session, metadata={"presentedFrames": 1, "mediaTime": .1}).status_code == 429
    clock.advance(2.99)
    assert upload(c, session, metadata={"presentedFrames": 1, "mediaTime": .1}).status_code == 429
    clock.advance(.02)
    for metadata in ({"presentedFrames": 0, "mediaTime": .1}, {"mediaTime": 0.}):
        assert upload(c, session, metadata=metadata).status_code == 409
    fresh = upload(c, session, metadata={"presentedFrames": 1, "mediaTime": .1})
    assert fresh.status_code == 200
    assert fresh.json()["frameCount"] == 2
    copy = c.app.state.live_debug.status(session["sessionId"], session["diagnosticId"])
    copy["latest"]["metadata"]["presentedFrames"] = 5000
    assert c.get(debug_url(session) + "/status", headers=auth(session)).json()["latest"]["metadata"]["presentedFrames"] == 1
    repeated_start = c.post(debug_url(session), json={"enabled": True, "consent": True}, headers=auth(session)).json()
    assert repeated_start["expiresAt"] == state["expiresAt"]
    assert repeated_start["frameCount"] == 2
    assert upload(c, session, metadata={"presentedFrames": 2, "mediaTime": .2}).status_code == 429


def test_ring_keeps_last_eight_generated_files(debug_client, tmp_path):
    c = debug_client
    clock = Clock()
    c.app.state.live_debug.clock = clock
    session = new_session(c, "cameraMatch")
    start_debug(c, session)
    for counter in range(11):
        response = upload(c, session, metadata={"presentedFrames": counter})
        assert response.status_code == 200, response.text
        assert response.json()["frameCount"] == min(counter + 1, 8)
        clock.advance()
    directory = tmp_path / "live-debug" / session["diagnosticId"]
    assert sorted(path.name for path in directory.glob("*.png")) == [f"{n:06d}.png" for n in range(4, 12)]
    assert c.get(debug_url(session) + "/status", headers=auth(session)).json()["latest"]["sequence"] == 11


def test_live_debug_zero_media_clock_keeps_actual_advancing_frames_without_measurement(debug_client):
    c=debug_client;clock=Clock();c.app.state.live_debug.clock=clock
    session=new_session(c,"cameraMatch");start_debug(c,session)
    for counter in range(1,5):
        result=upload(c,session,metadata={"presentedFrames":counter,"mediaTime":0})
        assert result.status_code==200,result.text
        clock.advance()
    assert upload(c,session,metadata={"presentedFrames":4,"mediaTime":0}).status_code==409
    assert c.get('/api/sessions/'+session['sessionId'],headers=auth(session)).json()['measurements']==[]


def test_global_bytes_cap_counts_all_sessions_and_stop_reclaims_budget(tmp_path):
    from colorlab.live_debug import LiveDebugStore
    clock = Clock()
    data = image_bytes()
    size = len(data)
    store = LiveDebugStore(tmp_path / "private", clock=clock, total_limit=size * 2)
    store.start("a", "test-" + "a" * 24, clock() + 3600)
    store.start("b", "test-" + "b" * 24, clock() + 3600)
    store.append("a", data, {}, "image/png")
    store.append("b", data, {}, "image/png")
    clock.advance()
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        store.append("a", data, {}, "image/png")
    assert exc.value.status_code == 429
    assert sum(path.stat().st_size for path in tmp_path.glob("private/*/*.png")) <= size * 2
    store.stop("b")
    assert store.append("a", data, {}, "image/png")["frameCount"] == 2


@pytest.mark.parametrize("stop", ["disable", "delete", "ttl", "sessionExpiry", "disconnect"])
def test_stop_expiry_and_disconnect_purge_private_images(debug_client, tmp_path, stop):
    c = debug_client
    clock = Clock()
    c.app.state.live_debug.clock = clock
    session = new_session(c, "cameraMatch")
    ws = camera(c, session)
    assert c.post(debug_url(session), json={"enabled": True, "consent": True}, headers=auth(session)).status_code == 200
    assert upload(c, session).status_code == 200
    path = tmp_path / "live-debug" / session["diagnosticId"] / "000001.png"
    assert path.exists()
    if stop == "disable":
        response = c.post(debug_url(session), json={"enabled": False, "consent": False}, headers=auth(session))
        assert response.status_code == 200
        assert response.json()["enabled"] is False
        assert response.json()["latest"] is None
        assert upload(c, session).status_code == 409
    elif stop == "delete":
        assert c.delete("/api/sessions/" + session["sessionId"], headers=auth(session)).status_code == 200
    elif stop == "ttl":
        clock.advance(300)
        c.get("/api/health")
        state = c.get(debug_url(session) + "/status", headers=auth(session)).json()
        assert state["enabled"] is False
        assert state["latest"] is None
        assert upload(c, session).status_code == 409
    elif stop == "sessionExpiry":
        c.app.state.sessions[session["sessionId"]]["expiry"] = 0
        assert c.get("/api/health").status_code == 200
    else:
        ws.close()
        # The disconnect's emitted snapshot runs before this HTTP privacy sweep.
        c.get("/api/health")
        assert c.get(debug_url(session) + "/status", headers=auth(session)).json()["enabled"] is False
    assert not path.exists()
    assert not path.parent.exists()
    assert c.get(debug_url(session) + "/frames/latest", headers=auth(session)).status_code == 404


def test_lifespan_shutdown_purges_frames(tmp_path, monkeypatch):
    from colorlab.app import create_app
    monkeypatch.setenv("COLORLAB_DATA_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        session = new_session(c, "cameraMatch")
        start_debug(c, session)
        assert upload(c, session).status_code == 200
        assert list(tmp_path.glob("live-debug/*/*.png"))
    assert not list(tmp_path.glob("live-debug/*/*.png"))


def test_restart_starts_disabled_and_sweeps_orphan_debug_files(tmp_path):
    from colorlab.live_debug import LiveDebugStore
    clock = Clock()
    directory = tmp_path / "private"
    first = LiveDebugStore(directory, clock=clock)
    first.start("a", "test-" + "a" * 24, clock() + 3600)
    first.append("a", image_bytes(), {}, "image/png")
    assert list(directory.glob("*/*.png"))
    restarted = LiveDebugStore(directory, clock=clock)
    assert restarted.status("a", "test-" + "a" * 24)["enabled"] is False
    assert not list(directory.glob("*/*.png"))


@pytest.mark.parametrize("link", ["root", "session"])
def test_symlink_directories_cannot_write_outside_private_store(debug_client, tmp_path, link):
    c = debug_client
    session = new_session(c, "cameraMatch")
    start_debug(c, session)
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "live-debug"
    if link == "root":
        root.symlink_to(outside, target_is_directory=True)
    else:
        root.mkdir()
        (root / session["diagnosticId"]).symlink_to(outside, target_is_directory=True)
    response = upload(c, session)
    assert response.status_code == 503
    assert not list(outside.iterdir())
    assert str(outside) not in response.text


def test_authenticated_preview_does_not_follow_replaced_file_symlink(debug_client, tmp_path):
    c = debug_client
    session = new_session(c, "cameraMatch")
    start_debug(c, session)
    assert upload(c, session).status_code == 200
    path = tmp_path / "live-debug" / session["diagnosticId"] / "000001.png"
    outside = tmp_path / "private-secret"
    outside.write_bytes(b"private secret")
    path.unlink()
    path.symlink_to(outside)
    response = c.get(debug_url(session) + "/frames/latest", headers=auth(session))
    assert response.status_code == 503
    assert b"private secret" not in response.content


def test_private_status_cache_policy_consent_audit_and_no_wrong_session_access(debug_client, tmp_path):
    c = debug_client
    session = new_session(c, "cameraMatch")
    other = new_session(c, "cameraMatch")
    camera(c, session)
    url = debug_url(session)
    start = c.post(url, json={"enabled": True, "consent": True}, headers=auth(session))
    assert start.headers["cache-control"] == "no-store"
    assert c.get(url + "/status", headers=auth(session)).headers["cache-control"] == "no-store"
    assert c.get(url + "/status", headers=auth(other)).status_code == 401
    assert c.post(url, json={"enabled": True, "consent": True}, headers=auth(other)).status_code == 401
    assert c.post(url + "/frames", headers=auth(other), files={"file": ("sample.png", image_bytes(), "image/png")}).status_code == 401
    assert c.post(url, json={"enabled": True, "consent": True}, headers={"Authorization": auth(session)["Authorization"]}).status_code == 403
    assert c.post(url, json={"enabled": "true", "consent": True}, headers=auth(session)).status_code == 422
    assert c.post(url, json={"enabled": True, "consent": True, "private": "secret"}, headers=auth(session)).status_code == 422
    rows = [json.loads(line) for path in (tmp_path / "diagnostics").glob("*.jsonl") for line in path.read_text().splitlines()]
    assert any(row["diagnosticId"] == session["diagnosticId"] and row["event"] == "enabled" and row["details"] == {} for row in rows)
    assert c.post(url, json={"enabled": False}, headers=auth(session)).status_code == 200
    rows = [json.loads(line) for path in (tmp_path / "diagnostics").glob("*.jsonl") for line in path.read_text().splitlines()]
    assert any(row["diagnosticId"] == session["diagnosticId"] and row["event"] == "disabled" and row["details"] == {} for row in rows)
    assert all(session["cameraToken"] not in json.dumps(row) and session["displayToken"] not in json.dumps(row) for row in rows)


def test_idle_existing_sweep_removes_expired_frames_without_request(debug_client, tmp_path, monkeypatch):
    import threading
    c = debug_client
    clock = Clock()
    store = c.app.state.live_debug
    store.clock = clock
    session = new_session(c, "cameraMatch")
    start_debug(c, session)
    assert upload(c, session).status_code == 200
    path = tmp_path / "live-debug" / session["diagnosticId"] / "000001.png"
    deleted = threading.Event()
    purge = store._purge_directory

    def observed_purge(directory):
        purge(directory)
        deleted.set()

    monkeypatch.setattr(store, "_purge_directory", observed_purge)
    clock.advance(300)
    assert deleted.wait(3), "existing lifespan sweep did not purge idle debug frames"
    assert not path.exists()
    assert session["sessionId"] not in store.sessions


def test_debug_expiry_cannot_outlive_session_or_renew_on_repeated_start(tmp_path):
    from colorlab.live_debug import LiveDebugStore
    clock = Clock()
    store = LiveDebugStore(tmp_path / "private", clock=clock)
    state = store.start("a", "test-" + "a" * 24, clock() + 10)
    assert datetime.fromisoformat(state["expiresAt"]).timestamp() == pytest.approx(clock() + 10, rel=0, abs=1e-6)
    clock.advance(5)
    assert store.start("a", "test-" + "a" * 24, clock() + 3600)["expiresAt"] == state["expiresAt"]
    clock.advance(5)
    assert store.status("a", "test-" + "a" * 24)["enabled"] is False
