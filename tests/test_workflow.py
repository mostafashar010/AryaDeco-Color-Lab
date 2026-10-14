"""Actual server + color engine + original images; not a physical camera test."""

import csv
import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageCms

ROOT = Path(__file__).parents[1]


def client_app():
    try:
        from colorlab.app import app
    except ImportError:
        pytest.fail("Integrated Color Lab application is not available yet")
    return TestClient(app)


def require(response, expected=200):
    assert response.status_code == expected, response.text
    return response.json()


def session(client):
    result = require(client.post("/api/sessions", json={"mode": "replay", "conditions": {}}, headers={"Origin": "http://localhost:8443"}))
    return result, {"Authorization": f"Bearer {result['cameraToken']}", "Origin": "http://localhost:8443"}


@pytest.mark.parametrize("filename,space", [
    ("01-striped-sheer.jpg", "srgb"),
    ("02-swatch-bands.jpg", "display-p3"),
])
def test_original_image_replay_is_experimental_and_exports_independent_fields(filename, space):
    with client_app() as client:
        created, headers = session(client)
        base = f"/api/sessions/{created['sessionId']}"
        path = ROOT / "references" / filename
        assert path.is_file(), "Immutable actual reference image fixture required"
        upload = require(client.post(base + "/images", headers=headers, files={"file": (filename, path.read_bytes(), "image/jpeg")}, data={"retention": "false"}))
        assert upload["sourceColorSpace"] == space
        if space == "display-p3":
            polygon = [[210 / 864, 280 / 1536], [670 / 864, 280 / 1536], [670 / 864, 370 / 1536], [210 / 864, 370 / 1536]]
        else:
            polygon = [[600 / 1536, 250 / 1150], [1150 / 1536, 250 / 1150], [1150 / 1536, 280 / 1150], [600 / 1536, 280 / 1150]]
        region = {"id": "reference-region-1", "label": "AI draft, not a physical measurement", "order": 0, "mode": "bands", "polygon": polygon, "exclusions": [], "background": None, "layers": None, "direction": None, "operatorConfirmed": False}
        require(client.post(base + f"/images/{upload['captureId']}/regions", headers=headers, json={"regions": [region]}))
        report = require(client.get(base + "/export?format=json&kind=experimental", headers=headers))
        assert report["measurements"]
        measurement = report["measurements"][0]
        assert measurement["displayDriveRgb"] is None
        assert measurement["instrumentDeltaE00"] is None
        assert measurement["independentValidationStatus"] == "notTested"
        assert measurement["sourceColorSpace"] == space
        approved = require(client.get(base + "/export?format=json&kind=approved", headers=headers))
        assert all(item["catalogHexSrgb"] is None for item in approved["measurements"])
        response = client.get(base + "/export?format=csv&kind=experimental", headers=headers)
        assert response.status_code == 200
        rows = list(csv.DictReader(io.StringIO(response.text)))
        assert rows and "catalogHexSrgb" in rows[0] and "displayDriveRgb" in rows[0]
        assert rows[0]["displayDriveRgb"] in ("", "null")
        require(client.delete(base, headers=headers))
        assert client.get(base, headers=headers).status_code in (401, 404, 410)


def test_display_token_cannot_read_export_or_delete_measurement_session():
    with client_app() as client:
        created, _ = session(client)
        base = f"/api/sessions/{created['sessionId']}"
        headers = {"Authorization": f"Bearer {created['displayToken']}", "Origin": "http://localhost:8443"}
        assert client.get(base + "/export?format=json", headers=headers).status_code in (401, 403)
        assert client.delete(base, headers=headers).status_code in (401, 403)


def test_authenticated_browser_get_without_origin_and_wrong_origin_rejection():
    with client_app() as client:
        created, headers = session(client)
        base = f"/api/sessions/{created['sessionId']}"
        require(client.get(base, headers={"Authorization": headers["Authorization"]}))
        assert client.get(base, headers={**headers, "Origin": "https://attacker.invalid"}).status_code == 403


def test_three_stage_cannot_skip_display_stage_by_submitting_measurements():
    with client_app() as client:
        created = require(client.post("/api/sessions", headers={"Origin": "http://localhost:8443"}, json={"mode": "threeStage", "conditions": {}}))
        base = f"/api/sessions/{created['sessionId']}"
        headers = {"Authorization": f"Bearer {created['cameraToken']}", "Origin": "http://localhost:8443"}
        region = {"id": "attempt-skip", "label": "cannot skip", "order": 0, "mode": "solid", "polygon": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], "exclusions": [], "background": None, "layers": None, "direction": None, "operatorConfirmed": True}
        response = client.post(base + "/measurements", headers=headers, json={"region": region, "frames": [], "sourceColorSpace": "srgb", "sourceCaptureIds": [], "capturedAt": "2026-10-13T11:00:00Z"})
        assert response.status_code in (409, 422)
        snapshot = require(client.get(base, headers=headers))
        assert snapshot["state"] != "fabric"
        assert snapshot["measurements"] == []


def test_p3_preview_is_canonical_srgb_and_does_not_reapply_original_profile():
    with client_app() as client:
        created, headers = session(client)
        base = f"/api/sessions/{created['sessionId']}"
        path = ROOT / "references/02-swatch-bands.jpg"
        original = Image.open(path)
        input_profile = ImageCms.ImageCmsProfile(io.BytesIO(original.info["icc_profile"]))
        expected = ImageCms.profileToProfile(original, input_profile, ImageCms.createProfile("sRGB"), renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, outputMode="RGB")
        uploaded = require(client.post(base + "/images", headers=headers, files={"file": (path.name, path.read_bytes(), "image/jpeg")}, data={"retention": "false"}))
        preview_response = client.get(uploaded["previewUrl"], headers=headers)
        assert preview_response.status_code == 200
        preview = Image.open(io.BytesIO(preview_response.content))
        assert preview.size == original.size
        if preview.info.get("icc_profile"):
            profile = ImageCms.ImageCmsProfile(io.BytesIO(preview.info["icc_profile"]))
            assert "srgb" in ImageCms.getProfileDescription(profile).lower()
            assert "p3" not in ImageCms.getProfileDescription(profile).lower()
        # Independent LittleCMS 8-bit check at interiors. Small quantization/ICC tolerance,
        # not physical fabric accuracy and not comparison against a fixture HEX.
        for point in [(400, 300), (400, 450), (400, 600), (400, 700), (400, 850)]:
            assert max(abs(a - b) for a, b in zip(preview.getpixel(point), expected.getpixel(point))) <= 3
        require(client.delete(base, headers=headers))


def test_manual_override_creates_unapproved_version_without_modifying_source():
    with client_app() as client:
        created, headers = session(client)
        base = f"/api/sessions/{created['sessionId']}"
        path = ROOT / "references/02-swatch-bands.jpg"
        uploaded = require(client.post(base + "/images", headers=headers, files={"file": (path.name, path.read_bytes(), "image/jpeg")}, data={"retention": "false"}))
        region = {"id": "override-draft", "label": "override source", "order": 0, "mode": "bands", "polygon": [[0.3, 0.18], [0.7, 0.18], [0.7, 0.24], [0.3, 0.24]], "exclusions": [], "background": None, "layers": None, "direction": None, "operatorConfirmed": False}
        require(client.post(base + f"/images/{uploaded['captureId']}/regions", headers=headers, json={"regions": [region]}))
        before = require(client.get(base, headers=headers))["measurements"][0]
        override = require(client.post(base + f"/measurements/{before['id']}/override", headers=headers, json={"catalogHexSrgb": "#123456", "reason": "synthetic test manual edit; not physical measurement"}))
        assert override["id"] != before["id"]
        assert override["catalogHexSrgb"] == "#123456"
        assert override["approved"] is False
        assert override["displayDriveRgb"] is None
        after = require(client.get(base, headers=headers))["measurements"]
        assert after[0] == before
        assert len(after) == 2
        report = require(client.get(base + "/export?format=json&kind=approved", headers=headers))
        assert all(measurement["catalogHexSrgb"] is None for measurement in report["measurements"])
        require(client.delete(base, headers=headers))


def test_blank_white_replay_region_retains_clipping_failure_not_fabric_hex():
    image = Image.new("RGB", (64, 64), (255, 255, 255))
    image_bytes = io.BytesIO()
    image.save(image_bytes, format="PNG", icc_profile=ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
    with client_app() as client:
        created, headers = session(client)
        base = f"/api/sessions/{created['sessionId']}"
        uploaded = require(client.post(base + "/images", headers=headers, files={"file": ("synthetic-clipped.png", image_bytes.getvalue(), "image/png")}, data={"retention": "false"}))
        region = {"id": "clipped", "label": "synthetic clipping fixture", "order": 0, "mode": "solid", "polygon": [[0, 0], [1, 0], [1, 1], [0, 1]], "exclusions": [], "background": None, "layers": None, "direction": None, "operatorConfirmed": True}
        require(client.post(base + f"/images/{uploaded['captureId']}/regions", headers=headers, json={"regions": [region]}))
        result = require(client.get(base, headers=headers))["measurements"][0]
        assert result["captureQuality"] == "rejected"
        assert result["catalogHexSrgb"] is None
        require(client.delete(base, headers=headers))


def test_uploaded_full_image_never_becomes_public_preview():
    with client_app() as client:
        created, headers = session(client)
        base = f"/api/sessions/{created['sessionId']}"
        path = ROOT / "references/02-swatch-bands.jpg"
        uploaded = require(client.post(base + "/images", headers=headers, files={"file": (path.name, path.read_bytes(), "image/jpeg")}, data={"retention": "false"}))
        assert "token=" not in uploaded["previewUrl"]
        assert client.get(uploaded["previewUrl"]).status_code in (401, 403)
        display_headers = {"Authorization": f"Bearer {created['displayToken']}"}
        assert client.get(uploaded["previewUrl"], headers=display_headers).status_code in (401, 403)
        require(client.delete(base, headers=headers))
        assert client.get(uploaded["previewUrl"], headers=headers).status_code in (401, 404, 410)


def test_archive_preview_does_not_use_a_second_p3_decode():
    # Source copy and original profile remain immutable despite API preview requests.
    import hashlib
    path = ROOT / "references/02-swatch-bands.jpg"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == "ae19fc687b927e4af8362add615a6667a14ff5106a628189937811318b92c2e2"
    with Image.open(path) as image:
        assert "Display P3" in ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(image.info["icc_profile"])))
