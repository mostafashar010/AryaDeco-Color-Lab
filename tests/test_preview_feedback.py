"""Synthetic camera feedback, not physical color or firmware validation."""
import copy

import numpy as np
import pytest

from test_api import auth, client, new_session
from test_live_preview import active, preview
from test_protocol import message


def request(frame=1):
    body = preview(frame)
    body.update(fingerprint="settings-1", canvasColorSpace="srgb")
    body["sourceFrame"]["mediaTime"] = 0.
    return body


def send(c, s, camera, display, body):
    c.app.state.sessions[s["sessionId"]]["previewIssuedAt"] = 0.
    response = c.post("/api/sessions/" + s["sessionId"] + "/live-preview", headers=auth(s), json=body)
    if response.status_code == 200:
        camera.receive_json()
        display.receive_json()
    return response


def acknowledge(camera, display, s, patch, sequence=2):
    display.send_json(message(s, "display", "display.patch.rendered", {
        "profileVersion": 0, "patchId": patch["patchId"],
        "commandSequence": patch["commandSequence"], "renderedAt": float(sequence)}, sequence))
    camera.receive_json()
    display.receive_json()


def feedback(patch, observed=None):
    bits = [0, 1, 0, 1] + [int(x) for x in f'{patch["commandSequence"]:024b}']
    return {"commandSequence": patch["commandSequence"], "patchId": patch["patchId"],
            "markerPixels": [[float(bit)] * 3 for bit in bits], "stable": True,
            "screenRoi": [[.05, .1], [.25, .1], [.25, .9], [.05, .9]],
            "screenAppearanceBands": [{"id": band["id"], "rgb": observed or band["drive"],
                "validPixels": 64, "validBlocks": 4, "blockSpread": .01, "clippedRate": 0.}
                for band in patch["bands"]]}


def test_measured_multi_band_feedback_corrects_opposite_errors_without_catalog_claims():
    with client() as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            first = send(c, s, camera, display, request()).json()
            acknowledge(camera, display, s, first)
            body = request(2)
            body["feedback"] = feedback(first)
            body["feedback"]["screenAppearanceBands"][0]["rgb"] = [.15, .35, .55]
            body["feedback"]["screenAppearanceBands"][1]["rgb"] = [.65, .35, .25]
            response = send(c, s, camera, display, body)
            assert response.status_code == 200, response.text
            patch = response.json()
            assert np.all(np.array(patch["bands"][0]["drive"]) > first["bands"][0]["drive"])
            assert np.all(np.array(patch["bands"][1]["drive"]) < first["bands"][1]["drive"])
            assert patch["cameraAppearanceBands"] == body["bands"]
            assert patch["compensation"]["status"] == "measuredFeedbackExperimental"
            assert patch["compensation"]["physicalAccuracyVerified"] is False
            assert all(b["residualBefore"] > 0 for b in patch["compensation"]["perBand"])
            assert all(b["residualAfter"] is None for b in patch["compensation"]["perBand"])
            assert c.app.state.sessions[s["sessionId"]]["measurements"] == []
            from colorlab.models import LiveBandsCommand
            LiveBandsCommand.model_validate(patch)


@pytest.mark.parametrize("mutation,status", [
    (lambda b: b["feedback"].update(commandSequence=999), 409),
    (lambda b: b["feedback"].update(patchId="stale"), 409),
    (lambda b: b["feedback"].update(markerPixels=[[.5] * 3] * 28), 422),
    (lambda b: b["feedback"]["screenAppearanceBands"][0].update(id="wrong"), 422),
    (lambda b: b["feedback"].update(stable=False), 422),
    (lambda b: b["feedback"]["screenAppearanceBands"][0].update(validBlocks=1), 422),
    (lambda b: b["feedback"].update(screenRoi=[[.1, .1]] * 4), 422),
    (lambda b: b["feedback"].update(screenRoi=[[.1, .1], [.1001, .1], [.1001, .1001], [.1, .1001]]), 422),
    (lambda b: b.update(fingerprint="other"), 409),
    (lambda b: b["sourceFrame"].update(presentedFrames=1), 409),
])
def test_feedback_rejects_untrusted_evidence_without_replacing_command(mutation, status):
    with client() as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            first = send(c, s, camera, display, request()).json()
            body = request(2)
            body["feedback"] = feedback(first)
            assert send(c, s, camera, display, body).status_code == 409
            acknowledge(camera, display, s, first)
            mutation(body)
            assert send(c, s, camera, display, body).status_code == status
            assert c.app.state.sessions[s["sessionId"]]["currentPatch"]["commandSequence"] == first["commandSequence"]


def test_feedback_preserved_without_observation_and_reset_on_target_or_geometry_drift():
    with client() as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            first = send(c, s, camera, display, request()).json()
            acknowledge(camera, display, s, first)
            body = request(2)
            body["feedback"] = feedback(first, [.1] * 3)
            corrected = send(c, s, camera, display, body).json()
            retained = send(c, s, camera, display, request(3)).json()
            assert retained["bands"] == corrected["bands"]
            assert retained["compensation"]["feedbackApplied"] is False
            acknowledge(camera, display, s, retained, 3)
            body = request(4)
            body["feedback"] = feedback(retained)
            body["feedback"]["screenRoi"] = [[.1, .1], [.3, .1], [.3, .9], [.1, .9]]
            reset = send(c, s, camera, display, body).json()
            assert reset["bands"] == request()["bands"]
            assert "previewFeedbackReset" in reset["compensation"]["warnings"]
            changed = request(5)
            changed["bands"][0]["drive"] = [.8] * 3
            output = send(c, s, camera, display, changed).json()
            assert output["bands"] == changed["bands"]


def test_profile_unsupported_band_does_not_stall_supported_bands():
    from colorlab.display_response import characterize, response_steps
    import time
    with client() as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            state = c.app.state.sessions[s["sessionId"]]
            profile = characterize([{**step, "patchId": str(i), "rgb": (np.asarray(step["drive"]) ** 2.2).tolist()}
                                    for i, step in enumerate(response_steps())])
            profile.update(profileVersion=0, conditions={}, capabilities={}, expiresAt=time.time() + 600,
                           fingerprint="settings-1", nativeCanvasColorSpace="srgb", width=640, height=480)
            state["responseProfile"] = profile
            body = request()
            body["bands"][0]["drive"] = [.4] * 3
            body["bands"][1]["drive"] = [.98] * 3
            response = send(c, s, camera, display, body)
            assert response.status_code == 200, response.text
            output = response.json()
            assert output["compensation"]["status"] == "partiallyCompensatedExperimental"
            assert output["compensation"]["perBand"][0]["status"] == "cameraReferencedExperimental"
            assert output["compensation"]["perBand"][1]["status"] == "notCompensated"
            assert output["bands"][1]["drive"] == [.98] * 3
            assert "response_out_of_support" in output["compensation"]["perBand"][1]["warnings"]
            from colorlab.models import LiveBandsCommand
            LiveBandsCommand.model_validate(output)


def test_expired_feedback_cannot_change_display_drive():
    with client() as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            first = send(c, s, camera, display, request()).json()
            acknowledge(camera, display, s, first)
            state = c.app.state.sessions[s["sessionId"]]
            state["commands"][first["commandSequence"]]["issuedAt"] -= 3.
            body = request(2)
            body["feedback"] = feedback(first)
            result = send(c, s, camera, display, body)
            assert result.status_code == 409
            assert result.json()["detail"] == "preview_feedback_expired"


def test_damped_feedback_reduces_synthetic_gamma_cross_talk_error_with_bounded_steps():
    from colorlab.preview_feedback import correct_band
    from colorlab.engine import _linear
    matrix = np.array([[.7, .04, .02], [.03, .8, .03], [.02, .03, .65]])
    response = lambda drive: matrix @ np.asarray(drive) ** [1.8, 2.3, 2.] + [.02, .03, .02]
    target = response([.35, .42, .47])
    drive = np.array([.55, .3, .6])
    before = np.linalg.norm(target - response(drive))
    for _ in range(20):
        result = correct_band(drive, target, response(drive))
        next_drive = np.asarray(result["drive"])
        assert np.max(np.abs(next_drive - drive)) <= .08000001
        drive = next_drive
    assert np.linalg.norm(target - response(drive)) < before / 10
    saturated = correct_band([.99] * 3, [1.] * 3, [.1] * 3)
    assert saturated["drive"] == [1.] * 3
    assert saturated["saturated"]
    assert "displayDriveSaturated" in saturated["warnings"]
    assert saturated["residualAfter"] is None


def test_three_simultaneous_rest_bands_reduce_measured_error_over_acknowledged_iterations():
    import time
    from colorlab.engine import _linear, _encoded
    matrix = np.array([[.7, .04, .02], [.03, .8, .03], [.02, .03, .65]])
    response = lambda drive: matrix @ np.asarray(drive) ** [1.8, 2.3, 2.] + [.02, .03, .02]
    wanted = [[.35, .42, .47], [.6, .3, .2], [.25, .55, .35]]
    body = request()
    body["bands"] = [{"id": f"band-{i}", "drive": _encoded(response(drive)).tolist(),
                      "top": i / 3, "bottom": (i + 1) / 3} for i, drive in enumerate(wanted)]
    with client() as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            patch = send(c, s, camera, display, body).json()
            before = [np.linalg.norm(_linear(b["drive"]) - response(p["drive"]))
                      for b, p in zip(body["bands"], patch["bands"])]
            for i in range(12):
                time.sleep(.06)  # Respect the real WS rate limit, not a bypass.
                acknowledge(camera, display, s, patch, i + 2)
                current = copy.deepcopy(body)
                current["sourceFrame"]["presentedFrames"] = i + 2
                current["feedback"] = feedback(patch)
                for observed, band in zip(current["feedback"]["screenAppearanceBands"], patch["bands"]):
                    observed["rgb"] = _encoded(response(band["drive"])).tolist()
                output = send(c, s, camera, display, current)
                assert output.status_code == 200, output.text
                patch = output.json()
            after = [np.linalg.norm(_linear(b["drive"]) - response(p["drive"]))
                     for b, p in zip(body["bands"], patch["bands"])]
            assert all(a < b / 5 for a, b in zip(after, before)), (before, after)
            assert len(patch["bands"]) == 3
            assert c.app.state.sessions[s["sessionId"]]["measurements"] == []


@pytest.mark.parametrize("observed", [0., 1 / (4 * 255 * 12.92)])
def test_black_at_zero_or_nominal_quantization_noise_does_not_report_plateau(observed):
    from colorlab.preview_feedback import correct_band
    previous = None
    for _ in range(5):
        result = correct_band([0.] * 3, [0.] * 3, [observed] * 3, previous=previous)
        assert result["drive"] == [0.] * 3
        assert result["stalledIterations"] == 0
        assert "previewFeedbackPlateau" not in result["warnings"]
        assert result["saturated"] is (observed > 0)
        assert result["residualAfter"] is None
        assert result["physicalAccuracyVerified"] is False
        previous = result


@pytest.mark.parametrize("responds", [True, False])
def test_nearblack_progress_is_distinct_from_constant_positive_residual(responds):
    from colorlab.engine import _linear
    from colorlab.preview_feedback import correct_band
    target = _linear([.03] * 3)
    drive, previous = np.zeros(3), None
    for _ in range(5):
        observed = drive ** 2.2 if responds else np.zeros(3)
        result = correct_band(drive, target, observed, previous=previous)
        if responds:
            if previous:
                improvement = previous["residualBefore"] - result["residualBefore"]
                assert 0 < improvement < .001
            assert result["stalledIterations"] == 0
            assert "previewFeedbackPlateau" not in result["warnings"]
        assert np.max(np.abs(np.asarray(result["drive"]) - drive)) <= .08000001
        drive, previous = np.asarray(result["drive"]), result
    if not responds:
        assert result["stalledIterations"] == 4
        assert "previewFeedbackPlateau" in result["warnings"]
    assert result["residualAfter"] is None
    assert result["physicalAccuracyVerified"] is False
    floor = correct_band([0.] * 3, [0.] * 3, [.01] * 3)
    assert floor["drive"] == [0.] * 3
    assert floor["saturated"]
    assert "displayDriveSaturated" in floor["warnings"]


def test_constant_screen_response_reports_plateau_instead_of_success():
    from colorlab.preview_feedback import correct_band
    previous = None
    drive = [.5] * 3
    for _ in range(5):
        result = correct_band(drive, [.4] * 3, [.2] * 3, previous=previous)
        drive, previous = result["drive"], result
    assert "previewFeedbackPlateau" in result["warnings"]
    assert result["status"] == "measuredFeedbackExperimental"
    assert result["residualAfter"] is None


def test_response_jacobian_is_used_only_within_measured_drive_coverage():
    from colorlab.display_response import characterize, response_steps
    from colorlab.preview_feedback import correct_band
    profile = characterize([{**step, "patchId": str(i), "rgb": (np.asarray(step["drive"]) ** 2.2).tolist()}
                            for i, step in enumerate(response_steps())])
    profile["nativeCanvasColorSpace"] = "display-p3"
    inside = correct_band([.4] * 3, [.15] * 3, [.14] * 3, profile)
    assert inside["method"] == "measuredResponseJacobianFeedback"
    outside = correct_band([.95] * 3, [.8] * 3, [.7] * 3, profile)
    assert outside["method"] == "nominalTransferDampedFeedback"
    assert "response_out_of_support" in outside["warnings"]


def test_feedback_error_codes_remain_controlled_private_diagnostics():
    from colorlab.models import DiagnosticEvent
    for code in ("preview_feedback_stale_command", "preview_feedback_expired", "preview_feedback_context_changed",
                 "preview_feedback_marker_mismatch", "preview_feedback_context_required",
                 "preview_feedback_band_mismatch", "preview_feedback_screen_geometry_required",
                 "preview_feedback_pixel_count_exceeds_native_band"):
        DiagnosticEvent.model_validate({"sequence": 1, "elapsedMs": 0., "area": "api",
                                        "event": "rejected", "details": {"code": code}})


def test_cumulative_target_drift_resets_correction_from_last_accepted_feedback():
    with client() as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            first = send(c, s, camera, display, request()).json()
            acknowledge(camera, display, s, first)
            body = request(2)
            body["feedback"] = feedback(first, [.1] * 3)
            corrected = send(c, s, camera, display, body).json()
            for index in range(15):
                body = request(index + 3)
                body["bands"][0]["drive"][0] = .2 + .02 * (index + 1)
                patch = send(c, s, camera, display, body).json()
            assert patch["bands"][0]["drive"] != corrected["bands"][0]["drive"]
            assert patch["compensation"]["status"] != "measuredFeedbackExperimental"


def test_appearance_color_space_change_cannot_retain_measured_correction():
    with client() as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            first = send(c, s, camera, display, request()).json()
            acknowledge(camera, display, s, first)
            body = request(2)
            body["feedback"] = feedback(first, [.1] * 3)
            corrected = send(c, s, camera, display, body).json()
            body = request(3)
            body["cameraAppearanceColorSpace"] = "display-p3"
            patch = send(c, s, camera, display, body).json()
            assert patch["bands"] != corrected["bands"]
            assert patch["compensation"]["status"] != "measuredFeedbackExperimental"


@pytest.mark.parametrize("pixels,blocks", [(100000000, 8192), (256, 64), (16, 8)])
def test_feedback_counts_cannot_exceed_native_band_raster_or_block_density(pixels, blocks):
    with client() as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            first = send(c, s, camera, display, request()).json()
            acknowledge(camera, display, s, first)
            body = request(2)
            body["feedback"] = feedback(first)
            body["feedback"]["screenRoi"] = [[.1, .1], [.107, .1], [.107, .109], [.1, .109]]
            for band in body["feedback"]["screenAppearanceBands"]:
                band.update(validPixels=pixels, validBlocks=blocks)
            response = send(c, s, camera, display, body)
            assert response.status_code == 422, response.text


def test_native_fractional_bands_accept_real_256_sample_density():
    with client() as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            first = send(c, s, camera, display, request()).json()
            acknowledge(camera, display, s, first)
            body = request(2)
            body["feedback"] = feedback(first)
            body["feedback"]["screenRoi"] = [[.1001, .1001], [.5003, .1001], [.5003, .9002], [.1001, .9002]]
            for band in body["feedback"]["screenAppearanceBands"]:
                band.update(validPixels=256, validBlocks=16)
            response = send(c, s, camera, display, body)
            assert response.status_code == 200, response.text
            assert response.json()["compensation"]["feedbackApplied"]


@pytest.mark.parametrize("red_change", [28 / 255, 3 / 255])
def test_no_feedback_meaningful_target_shift_follows_fresh_color_not_old_drive(red_change):
    with client() as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            first = send(c, s, camera, display, request()).json()
            acknowledge(camera, display, s, first)
            body = request(2)
            body["feedback"] = feedback(first, [.1] * 3)
            corrected = send(c, s, camera, display, body).json()
            changed = request(3)
            changed["bands"][0]["drive"][0] += red_change
            result = send(c, s, camera, display, changed).json()
            assert result["bands"][0]["drive"] == changed["bands"][0]["drive"]
            assert result["bands"] != corrected["bands"]
            assert result["compensation"]["status"] != "measuredFeedbackExperimental"
            assert "previewFeedbackReset" in result["compensation"]["warnings"]


def test_no_feedback_single_byte_camera_noise_retains_correction():
    with client() as c:
        s = new_session(c, "cameraMatch")
        with active(c, s) as (camera, display):
            first = send(c, s, camera, display, request()).json()
            acknowledge(camera, display, s, first)
            body = request(2)
            body["feedback"] = feedback(first, [.1] * 3)
            corrected = send(c, s, camera, display, body).json()
            noisy = request(3)
            noisy["bands"][0]["drive"][0] += 1 / 255
            result = send(c, s, camera, display, noisy).json()
            assert result["bands"] == corrected["bands"]
            assert result["compensation"]["feedbackApplied"] is False
