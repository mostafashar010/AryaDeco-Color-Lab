from fastapi.testclient import TestClient


def client():
    from colorlab.app import create_app
    return TestClient(create_app())


def new_session(c, mode="threeStage"):
    response = c.post("/api/sessions", json={"mode": mode, "conditions": {}},
                      headers={"Origin": "http://localhost:8443"})
    assert response.status_code == 200, response.text
    return response.json()


def auth(s):
    return {"Origin": "http://localhost:8443", "Authorization": "Bearer " + s["cameraToken"]}


def activate_camera(c, s):
    from test_protocol import join, message
    ws = c.exit_stack.enter_context(c.websocket_connect("/ws/" + s["sessionId"], headers={"Origin": "http://localhost:8443"}))
    join(ws, s, "camera")
    ws.send_json(message(s, "camera", "session.resume", {"witnessChecked": True}, 2))
    assert ws.receive_json()["payload"]["paused"] is False
    return ws


def test_session_auth_origin_expiry_bounds_and_delete():
    with client() as c:
        assert c.get("/api/health").json()["storage"] == "ephemeral"
        assert c.post("/api/sessions", json={"mode": "replay", "conditions": {}}).status_code == 403
        assert c.post("/api/sessions", headers={"Origin": "http://localhost:8443"},
                      json={"mode": "replay", "conditions": {}, "extra": 1}).status_code == 422
        s = new_session(c)
        url = "/api/sessions/" + s["sessionId"]
        assert s["cameraToken"] != s["displayToken"]
        assert len(s["cameraToken"]) >= 32
        assert c.get(url, headers={"Origin": "http://localhost:8443"}).status_code == 401
        assert c.get(url, headers={**auth(s), "Authorization": "Bearer " + s["displayToken"]}).status_code == 401
        assert c.get(url, headers={**auth(s), "Origin": "http://evil.local"}).status_code == 403
        assert c.get(url, headers=auth(s)).json()["paused"] is True
        assert c.delete(url, headers=auth(s)).status_code == 200
        assert c.get(url, headers=auth(s)).status_code == 404


def test_exploratory_stage_order_invalidation_schema_and_approved_export():
    with client() as c:
        s = new_session(c, "catalogOnly")
        url = "/api/sessions/" + s["sessionId"]
        h = auth(s)
        profile = {"observations": [], "fingerprint": "settings-1"}
        assert c.post(url + "/camera-profile", json=profile, headers=h).status_code == 409
        assert c.post(url + "/reference", json={"exploratory": True}, headers=h).status_code == 200
        response = c.post(url + "/camera-profile", json=profile, headers=h)
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "exploratory"
        snapshot = c.get(url, headers=h).json()
        assert snapshot["state"] == "fabric"
        assert snapshot["profileVersion"] == 2
        assert c.get(url + "/export?format=json&kind=approved", headers=h).json()["measurements"] == []
        assert c.patch(url + "/conditions", json={"conditions": {"light": "changed"}}, headers=h).status_code == 200
        snapshot = c.get(url, headers=h).json()
        assert snapshot["cameraProfile"] is None
        assert snapshot["displayProfile"] is None
        assert snapshot["state"] == "reference"
        schema = c.get("/api/schema").json()
        assert schema["protocolVersion"] == 1
        assert "Frame" in schema["entities"]
        assert "device.join" in schema["events"]


def test_reference_strict_finite_shape_and_observer_validation():
    with client() as c:
        s = new_session(c)
        url = "/api/sessions/" + s["sessionId"] + "/reference"
        ref = {"id": "card", "label": "card", "source": "operator", "version": "1", "valueType": "XYZ",
               "referenceWhite": "D65", "observer": "2", "xyzScale": 1,
               "validity": "verified", "patches": [{"id": "p", "values": [0.1, 0.2, 0.3],
               "split": "train", "neutral": False}], "geometry": None, "health": None}
        assert c.post(url, json=ref, headers=auth(s)).status_code == 200
        ref["patches"].append(ref["patches"][0])
        assert c.post(url, json=ref, headers=auth(s)).status_code == 422
        ref["patches"] = [{**ref["patches"][0], "values": [True, 0.2, 0.3]}]
        assert c.post(url, json=ref, headers=auth(s)).status_code == 422


def frames(prefix="frame", value=0.4, source="videoCanvas"):
    return [{"id": f"{prefix}-{i}", "capturedAt": float(i * 120), "pixels": [[value] * 3 for _ in range(16)],
             "colorSpace": "srgb", "encoding": "encoded", "blockIds": [j // 4 for j in range(16)],
             "pixelCount": 16, "excludedCount": 0, "source": source, "settingsFingerprint": "settings-1",
             "markerSequence": None} for i in range(10)]


def region():
    return {"id": "region", "label": "fabric", "order": 0, "mode": "solid", "polygon": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
            "exclusions": [], "background": None, "layers": None, "direction": None, "operatorConfirmed": True}


def physical_batch(batch, number, roi_index):
    x = float(roi_index) * 0.2
    for i, f in enumerate(batch):
        f.update(presentedFrames=number * 20 + i, mediaTime=float(number * 2 + i * .12),
                 capturedAt=float(number * 2000 + i * 120), width=640, height=480,
                 regionId=f"roi-{roi_index}", roi=[[x, 0.1], [x + .1, 0.1], [x + .1, .2], [x, .2]])
    return batch


def test_analyze_measurements_independent_status_failure_retained_and_no_spoof():
    with client() as c:
        s = new_session(c, "catalogOnly")
        h = auth(s)
        url = "/api/sessions/" + s["sessionId"]
        body = {"frames": frames(), "region": region(), "sourceColorSpace": "srgb",
                "sourceCaptureIds": [f["id"] for f in frames()], "capturedAt": "2026-10-13T00:00:00Z"}
        assert c.post(url + "/measurements", json=body, headers=h).status_code == 409
        c.post(url + "/reference", json={"exploratory": True}, headers=h)
        c.post(url + "/camera-profile", json={"observations": [], "fingerprint": "settings-1"}, headers=h)
        activate_camera(c, s)
        analyzed = c.post(url + "/captures/analyze", json={"frames": frames(), "region": region()}, headers=h)
        assert analyzed.status_code == 200, analyzed.text
        assert analyzed.json()["quality"]["status"] == "accepted"
        r = c.post(url + "/measurements", json=body, headers=h)
        assert r.status_code == 200, r.text
        m = r.json()
        assert m["catalogStatus"] == "exploratory"
        assert m["displayStatus"] == "notMatched"
        assert not m["approved"]
        assert c.post(url + "/measurements", json=body, headers=h).status_code == 409
        body["frames"] = frames("rejected", 1.0)
        body["sourceCaptureIds"] = [f["id"] for f in body["frames"]]
        r = c.post(url + "/measurements", json=body, headers=h)
        assert r.status_code == 200
        assert r.json()["quality"]["status"] == "rejected"
        approved = c.get(url + "/export?kind=approved", headers=h).json()["measurements"]
        assert len(approved) == 2
        assert all(m["catalogColor"] is None for m in approved)
        assert "rejected" in c.get(url + "/export?format=csv&kind=approved", headers=h).text
        body["frames"][0]["pixels"][0][0] = True
        assert c.post(url + "/measurements", json=body, headers=h).status_code == 422


def test_explicit_image_decode_private_preview_region_and_delete():
    import io
    from PIL import Image
    image = Image.new("RGB", (40, 40), (100, 120, 140))
    data = io.BytesIO()
    image.save(data, format="PNG")
    with client() as c:
        s = new_session(c, "replay")
        h = auth(s)
        url = "/api/sessions/" + s["sessionId"]
        response = c.post(url + "/images", files={"file": ("sample.png", data.getvalue(), "image/png")}, headers=h)
        assert response.status_code == 200, response.text
        capture = response.json()
        assert capture["width"] == 40
        assert "assum" in str(capture["colorProvenance"]).lower()
        assert c.get(capture["previewUrl"]).status_code == 401
        preview = c.get(capture["previewUrl"], headers=h)
        assert preview.status_code == 200
        assert preview.headers["cache-control"] == "no-store"
        response = c.post(url + "/images/" + capture["captureId"] + "/regions", json={"regions": [region()]}, headers=h)
        assert response.status_code == 200, response.text
        m = response.json()["measurements"][0]
        assert m["catalogStatus"] == "exploratory"
        assert not m["approved"]
        assert m["provenance"] == "approximateReplay"
        report = c.get(url + "/export", headers=h).json()
        assert report["captures"][0]["id"] == capture["captureId"]
        assert report["captures"][0]["width"] == 40
        assert "sha256" in report["captures"][0]["metadata"]
        assert "rgb" not in report["captures"][0]
        assert report["captures"][0]["originalRetained"] is False
        assert c.delete(url, headers=h).status_code == 200
        assert c.get(capture["previewUrl"], headers=h).status_code == 404


def test_display_profile_cannot_accept_client_sequences_without_server_commands():
    with client() as c:
        s = new_session(c)
        h = auth(s)
        url = "/api/sessions/" + s["sessionId"]
        c.post(url + "/reference", json={"exploratory": True}, headers=h)
        c.post(url + "/camera-profile", json={"observations": [], "fingerprint": "settings-1"}, headers=h)
        body = {"observations": [{"drive": [0.4] * 3, "frames": frames(f"d-{i}"), "witnessFrames": frames(f"w-{i}"),
                "cardPatchId": None, "split": "train", "commandSequence": i + 1, "patchId": f"p-{i}"} for i in range(4)],
                "contaminationBaseline": frames("baseline"), "contaminationChecks": [frames("check")],
                "layout": "single", "fingerprint": "settings-1"}
        assert c.post(url + "/display-profile", json=body, headers=h).status_code == 409
        assert c.post(url + "/matches", json={"measurementId": "fake"}, headers=h).status_code == 409


def test_resource_limits_expiry_nested_nonfinite_and_complete_entity_schema():
    from colorlab.app import create_app
    with TestClient(create_app(max_sessions=1)) as c:
        s = new_session(c)
        assert c.post("/api/sessions", json={"mode": "replay", "conditions": {}}, headers={"Origin": "http://localhost:8443"}).status_code == 429
        url = "/api/sessions/" + s["sessionId"]
        assert c.patch(url + "/conditions", content='{"conditions":{"nested":{"x":NaN}}}', headers={**auth(s), "Content-Type": "application/json"}).status_code == 422
        assert c.patch(url + "/conditions", json={"conditions": {"x": "a" * 4097}}, headers=auth(s)).status_code == 422
        assert c.post(url + "/captures/analyze", content="x" * (16 * 1024 * 1024 + 1), headers=auth(s)).status_code == 413
        assert c.post(url + "/images", files={"file": ("huge.png", b"x" * (12 * 1024 * 1024 + 1), "image/png")}, headers=auth(s)).status_code == 413
        entities = c.get("/api/schema").json()["entities"]
        for name in ("Session", "DeviceCapabilityReport", "ReferenceTarget", "CameraProfile", "DisplayCompensationProfile", "Capture", "SampleRegion", "Measurement", "MatchRun", "ValidationReport"):
            assert name in entities
    with TestClient(create_app(ttl=0)) as c:
        s = new_session(c)
        assert c.get("/api/sessions/" + s["sessionId"], headers=auth(s)).status_code == 401


def test_replay_report_explicit_independent_instrument_and_drive_status():
    with client() as c:
        s = new_session(c, "replay")
        url = "/api/sessions/" + s["sessionId"]
        report = c.get(url + "/export", headers=auth(s)).json()
        assert report["exportKind"] == "experimental"
        assert report["independentValidationStatus"] == "notTested"


def test_authenticated_native_get_and_display_only_condition_change_preserves_catalog():
    with client() as c:
        s = new_session(c, "catalogOnly")
        h = auth(s)
        url = "/api/sessions/" + s["sessionId"]
        assert c.get(url, headers={"Authorization": h["Authorization"]}).status_code == 200
        c.post(url + "/reference", json={"exploratory": True}, headers=h)
        c.post(url + "/camera-profile", json={"observations": [], "fingerprint": "settings-1"}, headers=h)
        activate_camera(c, s)
        body = {"frames": frames(), "region": region(), "sourceColorSpace": "srgb", "sourceCaptureIds": [f["id"] for f in frames()], "capturedAt": "now"}
        c.post(url + "/measurements", json=body, headers=h)
        r = c.patch(url + "/conditions", json={"conditions": {"displayBrightness": 0.8}}, headers=h)
        assert r.status_code == 200
        snap = r.json()
        assert snap["cameraProfile"] is not None
        assert len(snap["measurements"]) == 1
        assert snap["displayProfile"] is None


def test_actual_video_identity_reuse_and_missing_physical_proof_cannot_approve():
    with client() as c:
        s = new_session(c, "catalogOnly")
        h = auth(s)
        url = "/api/sessions/" + s["sessionId"]
        c.post(url + "/reference", json={"exploratory": True}, headers=h)
        c.post(url + "/camera-profile", json={"observations": [], "fingerprint": "settings-1"}, headers=h)
        activate_camera(c, s)
        data = frames("physical")
        for i, f in enumerate(data):
            f.update(presentedFrames=i, mediaTime=float(i / 8), width=640, height=480,
                     regionId="fabric", roi=region()["polygon"], exclusions=[], sharpnessStatus="notAssessed")
        body = {"frames": data, "region": region(), "sourceColorSpace": "srgb",
                "sourceCaptureIds": [f["id"] for f in data], "capturedAt": "now"}
        r = c.post(url + "/measurements", json=body, headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["sourceFrameProvenance"][0]["width"] == 640
        assert r.json()["instrumentDeltaE00"] is None
        assert r.json()["displayDriveRgb"] is None
        assert r.json()["physicalControlStatus"] == "unverified"
        assert r.json()["independentValidationStatus"] == "notTested"
        from colorlab.models import Measurement
        Measurement.model_validate(r.json())
        for f in data:
            f["id"] += "-new"
            f["regionId"] = "renamed_same_roi"
            f["roi"] = f["roi"][1:] + f["roi"][:1]
        body["sourceCaptureIds"] = [f["id"] for f in data]
        assert c.post(url + "/measurements", json=body, headers=h).status_code == 409


def test_full_display_and_safe_match_loop_with_real_engine():
    from test_protocol import join, message
    with client() as c:
        s = new_session(c)
        h = auth(s)
        url = "/api/sessions/" + s["sessionId"]
        c.post(url + "/reference", json={"exploratory": True}, headers=h)
        c.post(url + "/camera-profile", json={"observations": [], "fingerprint": "settings-1"}, headers=h)
        version = c.get(url, headers=h).json()["profileVersion"]
        with c.websocket_connect("/ws/" + s["sessionId"], headers=h) as camera:
            join(camera, s, "camera")
            with c.websocket_connect("/ws/" + s["sessionId"], headers=h) as display:
                join(display, s, "display")
                camera.send_json(message(s, "camera", "session.resume", {"witnessChecked": True}, 2))
                camera.receive_json()
                display.receive_json()
                drives = [[.15,.15,.15], [.7,.2,.2], [.2,.7,.2], [.2,.2,.7], [.65,.65,.2], [.2,.65,.65], [.4,.4,.4], [.6,.3,.6], [.3,.6,.5]]
                observations = []
                for i, drive in enumerate(drives):
                    patch_id = f"display-{i}"
                    camera.send_json(message(s, "camera", "display.patch.set", {"profileVersion": version,
                        "patchId": patch_id, "displayDriveRgb": drive, "layout": "single", "sampleIds": []}, i + 3))
                    patch = camera.receive_json()["payload"]
                    display.receive_json()
                    display.send_json(message(s, "display", "display.patch.rendered", {"profileVersion": version,
                        "patchId": patch_id, "commandSequence": patch["commandSequence"], "renderedAt": float(i)}, i + 2))
                    camera.receive_json()
                    display.receive_json()
                    captured = frames(f"display-{i}")
                    marker = [[float(bit)] * 3 for bit in [0,1,0,1] + [int(x) for x in f'{patch["commandSequence"]:024b}']]
                    for f in captured:
                        f.update(pixels=[drive] * 16, markerSequence=patch["commandSequence"], markerPixels=marker)
                    observations.append({"drive": drive, "frames": captured, "witnessFrames": frames(f"witness-{i}"),
                        "cardFrames": frames(f"card-{i}"), "cardPatchId": "actual-card", "split": "train" if i < 6 else "holdout",
                        "commandSequence": patch["commandSequence"], "patchId": patch_id})
                    for index, name in enumerate(("frames", "witnessFrames", "cardFrames")):
                        physical_batch(observations[-1][name], i + 1, index)
                contamination = []
                for i, drive in enumerate(([0., 0., 0.], [1., 1., 1.], [0.7, 0.2, 0.2])):
                    camera.send_json(message(s, "camera", "display.patch.set", {"profileVersion": version,
                        "patchId": f"contamination-{i}", "displayDriveRgb": drive, "layout": "single", "sampleIds": []}, 12 + i))
                    patch = camera.receive_json()["payload"]
                    display.receive_json()
                    display.send_json(message(s, "display", "display.patch.rendered", {"profileVersion": version,
                        "patchId": patch["patchId"], "commandSequence": patch["commandSequence"], "renderedAt": float(i)}, 11 + i))
                    camera.receive_json()
                    display.receive_json()
                    neutral, fabric = frames(f"neutral-{i}"), frames(f"fabric-{i}")
                    physical_batch(neutral, 20 + i, 1)
                    physical_batch(fabric, 20 + i, 3)
                    marker = [[float(bit)] * 3 for bit in [0,1,0,1] + [int(x) for x in f'{patch["commandSequence"]:024b}']]
                    for f in neutral + fabric:
                        f.update(markerSequence=patch["commandSequence"], markerPixels=marker)
                    contamination.append((neutral, fabric))
                fit = {"observations": observations, "contaminationBaseline": contamination[0][0],
                       "contaminationChecks": [p[0] for p in contamination[1:]], "layout": "single", "fingerprint": "settings-1",
                       "contaminationFabricBaseline": contamination[0][1], "contaminationFabricChecks": [p[1] for p in contamination[1:]]}
                import copy
                unbound = copy.deepcopy(fit)
                for batch in [unbound["contaminationBaseline"], *unbound["contaminationChecks"], unbound["contaminationFabricBaseline"], *unbound["contaminationFabricChecks"]]:
                    for f in batch:
                        f.update(markerSequence=None, markerPixels=None)
                assert c.post(url + "/display-profile", json=unbound, headers=h).status_code == 422
                missing_card = copy.deepcopy(fit)
                for observation in missing_card["observations"]:
                    observation.pop("cardFrames")
                assert c.post(url + "/display-profile", json=missing_card, headers=h).status_code == 422
                contaminated = copy.deepcopy(fit)
                contaminated["contaminationFabricChecks"] = [frames("fabric-bad", 0.8)]
                assert c.post(url + "/display-profile", json=contaminated, headers=h).status_code == 422
                r = c.post(url + "/display-profile", json=fit, headers=h)
                assert r.status_code == 200, r.text
                assert r.json()["contaminationStatus"] == "neutralAndFabricPassed"
                assert r.json()["validation"]["cardPairing"] == "observed"
                from colorlab.models import DisplayCompensationProfile
                DisplayCompensationProfile.model_validate(r.json())
                camera.receive_json()
                display.receive_json()
                target_frames = frames("target", 0.5)
                measurement = c.post(url + "/measurements", json={"region": region(), "frames": target_frames,
                    "sourceColorSpace": "srgb", "sourceCaptureIds": [f["id"] for f in target_frames], "capturedAt": "now"}, headers=h)
                assert measurement.status_code == 200, measurement.text
                camera.receive_json()
                display.receive_json()
                start = c.post(url + "/matches", json={"measurementId": measurement.json()["id"], "maxEvaluations": 3}, headers=h)
                assert start.status_code == 200, start.text
                run = start.json()
                for ws in (camera, display):
                    ws.receive_json()
                    ws.receive_json()
                observed = frames("match", 0.5)
                physical_batch(observed, 30, 0)
                marker = [[float(bit)] * 3 for bit in [0,1,0,1] + [int(x) for x in f'{run["commandSequence"]:024b}']]
                for f in observed:
                    f.update(markerSequence=run["commandSequence"], markerPixels=marker)
                body = {"frames": observed, "witnessFrames": physical_batch(frames("match-witness"), 30, 1), "markerSequence": run["commandSequence"],
                    "cardFrames": physical_batch(frames("match-card"), 30, 2), "fabricFrames": physical_batch(frames("match-fabric", 0.5), 30, 3), "cardPatchId": "actual-card",
                    "commandSequence": run["commandSequence"], "patchId": run["patchId"], "stable": True, "layout": "single"}
                observe_url = url + "/matches/" + run["runId"] + "/observe"
                assert c.post(observe_url, json=body, headers=h).status_code == 409
                display.send_json(message(s, "display", "display.patch.rendered", {"profileVersion": version + 1,
                    "patchId": run["patchId"], "commandSequence": run["commandSequence"], "renderedAt": 15.}, 14))
                camera.receive_json()
                display.receive_json()
                body["frames"][0]["markerPixels"] = [[0.5] * 3] * 28
                assert c.post(observe_url, json=body, headers=h).status_code == 422
                body["frames"][0]["markerPixels"] = marker
                shifted = copy.deepcopy(body)
                for f in shifted["witnessFrames"]:
                    f["capturedAt"] += 1000
                assert c.post(observe_url, json=shifted, headers=h).status_code == 422
                shifted = copy.deepcopy(body)
                shifted["witnessFrames"][4]["capturedAt"] += 110
                assert c.post(observe_url, json=shifted, headers=h).status_code == 422
                r = c.post(observe_url, json=body, headers=h)
                assert r.status_code == 200, r.text
                assert r.json()["iterations"] == 1
                assert r.json()["nextDrive"] is not None
                for iteration in range(2, 4):
                    run = r.json()
                    for ws in (camera, display):
                        ws.receive_json()
                        ws.receive_json()
                    display.send_json(message(s, "display", "display.patch.rendered", {"profileVersion": version + 1,
                        "patchId": run["patchId"], "commandSequence": run["commandSequence"], "renderedAt": float(15 + iteration)}, 13 + iteration))
                    camera.receive_json()
                    display.receive_json()
                    observed = frames(f"match-{iteration}", 0.5)
                    physical_batch(observed, 30 + iteration, 0)
                    marker = [[float(bit)] * 3 for bit in [0,1,0,1] + [int(x) for x in f'{run["commandSequence"]:024b}']]
                    for f in observed:
                        f.update(markerSequence=run["commandSequence"], markerPixels=marker)
                    body = {"frames": observed, "witnessFrames": physical_batch(frames(f"match-witness-{iteration}"), 30 + iteration, 1), "markerSequence": run["commandSequence"],
                        "cardFrames": physical_batch(frames(f"match-card-{iteration}"), 30 + iteration, 2), "fabricFrames": physical_batch(frames(f"match-fabric-{iteration}", 0.5), 30 + iteration, 3), "cardPatchId": "actual-card",
                        "commandSequence": run["commandSequence"], "patchId": run["patchId"], "stable": True, "layout": "single"}
                    r = c.post(observe_url, json=body, headers=h)
                    assert r.status_code == 200, r.text
                assert r.json()["iterations"] == 3
                assert r.json()["nextDrive"] is None
                assert r.json()["terminationReason"] == "tolerance"
                assert c.post(observe_url, json=body, headers=h).status_code == 409
                assert c.get(url, headers=h).json()["measurements"][0]["catalogStatus"] == "exploratory"
                from colorlab.models import Measurement
                Measurement.model_validate(c.get(url, headers=h).json()["measurements"][0])


def test_validation_reports_are_append_only_operator_inputs_not_measurements():
    with client() as c:
        s = new_session(c, "replay")
        url = "/api/sessions/" + s["sessionId"]
        payload = {"type": "repeatability", "referenceWhite": "D65", "observer": "2",
                   "samples": [{"captureId": f"c{i}", "placementId": f"p{i}", "lab": [50., 0., float(i) / 10]} for i in range(10)]}
        r = c.post(url + "/validations", json=payload, headers=auth(s))
        assert r.status_code == 200, r.text
        assert r.json()["type"] == "repeatability"
        assert r.json()["independentValidationStatus"] == "notTested"
        from colorlab.models import ValidationReport
        ValidationReport.model_validate(r.json())
        report = c.get(url + "/export", headers=auth(s)).json()
        assert len(report["validationReports"]) == 1
        assert report["measurements"] == []
        assert report["validationReports"][0]["physicalEvidenceVerifiedBySoftware"] is False
        payload["samples"] = payload["samples"][:2]
        assert c.post(url + "/validations", json=payload, headers=auth(s)).status_code == 422


def test_manual_override_appends_new_unapproved_version_without_mutating_estimate():
    with client() as c:
        s = new_session(c, "catalogOnly")
        h = auth(s)
        url = "/api/sessions/" + s["sessionId"]
        c.post(url + "/reference", json={"exploratory": True}, headers=h)
        c.post(url + "/camera-profile", json={"observations": [], "fingerprint": "settings-1"}, headers=h)
        activate_camera(c, s)
        captured = frames("manual")
        m = c.post(url + "/measurements", headers=h, json={"frames": captured, "region": region(), "sourceColorSpace": "srgb",
            "sourceCaptureIds": [f["id"] for f in captured], "capturedAt": "now"}).json()
        r = c.post(url + "/measurements/" + m["id"] + "/override", headers=h, json={"catalogHexSrgb": "#AABBCC", "reason": "operator choice"})
        assert r.status_code == 200, r.text
        override = r.json()
        assert override["id"] != m["id"]
        assert override["sourceMeasurementId"] == m["id"]
        assert override["catalogHexSrgb"] == "#AABBCC"
        assert override["catalogStatus"] == "manualOverride"
        assert override["originalEstimate"] == m["catalogColor"]
        assert override["displayDriveRgb"] is None
        assert not override["approved"]
        assert c.get(url, headers=h).json()["measurements"][0] == m
        r = c.post(url + "/measurements/" + m["id"] + "/override", headers=h, json={"catalogHexSrgb": "javascript:bad", "reason": "x"})
        assert r.status_code == 422


def test_http_rate_limit_is_bounded():
    from colorlab.app import create_app
    with TestClient(create_app(request_rate=3)) as c:
        s = new_session(c)
        url = "/api/sessions/" + s["sessionId"]
        for _ in range(3):
            assert c.get(url, headers=auth(s)).status_code == 200
        assert c.get(url, headers=auth(s)).status_code == 429


def test_multipart_unknown_retention_field_rejected_and_original_default_discarded():
    import io
    from PIL import Image
    data = io.BytesIO()
    Image.new("RGB", (16, 16), (80, 80, 80)).save(data, format="PNG")
    with client() as c:
        s = new_session(c, "replay")
        url = "/api/sessions/" + s["sessionId"]
        files = {"file": ("x.png", data.getvalue(), "image/png")}
        assert c.post(url + "/images", headers=auth(s), files=files, data={"retainOriginal": "true"}).status_code == 422
        capture = c.post(url + "/images", headers=auth(s), files=files).json()
        assert c.app.state.sessions[s["sessionId"]]["images"][capture["captureId"]]["original"] is None


def test_static_display_route_serves_spa_without_public_originals(tmp_path):
    from colorlab.app import create_app
    (tmp_path / "index.html").write_text("<h1>Color Lab</h1>")
    with TestClient(create_app(static_dir=tmp_path)) as c:
        assert c.get("/display").status_code == 200
        assert "Color Lab" in c.get("/display").text
        assert c.get("/unknown-original.jpg").status_code == 404


def test_delete_revokes_connected_devices_and_metadata():
    from test_protocol import join
    import pytest
    from starlette.websockets import WebSocketDisconnect
    with client() as c:
        s = new_session(c)
        with c.websocket_connect("/ws/" + s["sessionId"], headers={"Origin": "http://localhost:8443"}) as camera:
            join(camera, s, "camera")
            assert c.delete("/api/sessions/" + s["sessionId"], headers=auth(s)).status_code == 200
            with pytest.raises(WebSocketDisconnect) as closed:
                camera.receive_json()
            assert closed.value.code == 1000
        assert s["sessionId"] not in c.app.state.sessions


def test_instrument_validation_binds_exact_server_measurement_version():
    with client() as c:
        s = new_session(c, "catalogOnly")
        h = auth(s)
        url = "/api/sessions/" + s["sessionId"]
        c.post(url + "/reference", json={"exploratory": True}, headers=h)
        c.post(url + "/camera-profile", json={"observations": [], "fingerprint": "settings-1"}, headers=h)
        activate_camera(c, s)
        c.app.state.sessions[s["sessionId"]]["conditions"] = {"geometry": "45/0"}
        captured = frames("instrument")
        sample_region = {**region(), "background": "white", "layers": 1}
        m = c.post(url + "/measurements", headers=h, json={"frames": captured, "region": sample_region, "sourceColorSpace": "srgb",
            "sourceCaptureIds": [f["id"] for f in captured], "capturedAt": "now"}).json()
        estimate = {"lab": m["catalogColor"]["lab"], "referenceWhite": "D65", "observer": "2", "geometry": "45/0", "background": "white", "layers": 1,
                    "measurementId": "wrong", "measurementVersion": 99}
        reading = {**estimate, "physicalMeasurementConfirmed": True, "instrumentId": "operator-instrument", "measuredAt": "2026-10-13T00:00:00Z", "method": "manual", "source": "operator"}
        reading.pop("measurementId")
        reading.pop("measurementVersion")
        payload = {"type": "instrument", "measurementId": m["id"], "estimate": estimate, "reading": reading}
        assert c.post(url + "/validations", json=payload, headers=h).status_code == 422
        estimate.update(measurementId=m["id"], measurementVersion=1)
        estimate["background"] = reading["background"] = "black"
        assert c.post(url + "/validations", json=payload, headers=h).status_code == 422
        estimate["background"] = reading["background"] = "white"
        r = c.post(url + "/validations", json=payload, headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["independentValidationStatus"] == "operatorSupplied"
        assert not r.json()["physicalEvidenceVerifiedBySoftware"]
        from colorlab.models import ValidationReport
        ValidationReport.model_validate(r.json())
        assert c.get(url, headers=h).json()["measurements"][0]["instrumentDeltaE00"] is None


def test_camera_extrapolation_rejection_is_retained_not_lost(monkeypatch):
    import colorlab.engine as engine
    def rejected(rgb, profile):
        raise ValueError("outside training coverage")
    monkeypatch.setattr(engine, "apply_camera", rejected)
    with client() as c:
        s = new_session(c, "catalogOnly")
        stored = c.app.state.sessions[s["sessionId"]]
        stored.update(state="fabric", cameraProfile={"status": "referenced", "matrix": [[1.,0.,0.], [0.,1.,0.], [0.,0.,1.]], "fingerprint": "settings-1"})
        activate_camera(c, s)
        captured = physical_batch(frames("coverage"), 2, 0)
        stored["cameraWitnesses"] = {"card": physical_batch(frames("base-card"), 1, 2)}
        url = "/api/sessions/" + s["sessionId"]
        r = c.post(url + "/measurements", headers=auth(s), json={"frames": captured, "region": region(), "sourceColorSpace": "srgb",
            "cardPatchId": "card", "cardFrames": physical_batch(frames("new-card"), 2, 2), "witnessFrames": physical_batch(frames("new-neutral"), 2, 1),
            "sourceCaptureIds": [f["id"] for f in captured], "capturedAt": "now"})
        assert r.status_code == 200, r.text
        assert r.json()["catalogStatus"] == "rejected"
        assert r.json()["catalogColor"] is None
        assert "outside training coverage" in r.json()["quality"]["warnings"]
        assert len(c.get(url + "/export?kind=approved", headers=auth(s)).json()["measurements"]) == 1


def test_conditions_change_during_processing_cannot_append_stale_measurement(monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    import colorlab.engine as engine
    entered = threading.Event()
    release = threading.Event()
    real = engine.summarize_frames
    def blocked(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return real(*args, **kwargs)
    monkeypatch.setattr(engine, "summarize_frames", blocked)
    with client() as c:
        s = new_session(c, "catalogOnly")
        h = auth(s)
        url = "/api/sessions/" + s["sessionId"]
        c.post(url + "/reference", json={"exploratory": True}, headers=h)
        c.post(url + "/camera-profile", json={"observations": [], "fingerprint": "settings-1"}, headers=h)
        activate_camera(c, s)
        captured = frames("race")
        body = {"frames": captured, "region": region(), "sourceColorSpace": "srgb", "sourceCaptureIds": [f["id"] for f in captured], "capturedAt": "now"}
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(c.post, url + "/measurements", json=body, headers=h)
            assert entered.wait(3)
            assert c.patch(url + "/conditions", json={"conditions": {"illumination": "changed"}}, headers=h).status_code == 200
            release.set()
            assert pending.result().status_code == 409
        assert c.get(url, headers=h).json()["measurements"] == []


def test_live_measurement_rejects_paused_without_camera_ownership():
    with client() as c:
        s = new_session(c, "catalogOnly")
        h = auth(s)
        url = "/api/sessions/" + s["sessionId"]
        c.post(url + "/reference", json={"exploratory": True}, headers=h)
        c.post(url + "/camera-profile", json={"observations": [], "fingerprint": "settings-1"}, headers=h)
        captured = frames("paused")
        r = c.post(url + "/measurements", headers=h, json={"frames": captured, "region": region(), "sourceColorSpace": "srgb",
            "sourceCaptureIds": [f["id"] for f in captured], "capturedAt": "now"})
        assert r.status_code == 409
        assert c.get(url, headers=h).json()["measurements"] == []


def test_expiry_purges_retained_images_without_session_touch():
    with client() as c:
        s = new_session(c)
        stored = c.app.state.sessions[s["sessionId"]]
        stored["images"]["private"] = {"original": b"private"}
        stored["cameraWitnesses"] = {"card": [{"pixels": [[0.4, 0.4, 0.4]]}]}
        stored["displayCardWitness"] = {"frames": [{"pixels": [[0.4, 0.4, 0.4]]}]}
        stored["expiry"] = 0
        assert c.get("/api/health").status_code == 200
        assert s["sessionId"] not in c.app.state.sessions
        assert stored["images"] == {}
        assert stored["cameraWitnesses"] == {}
        assert stored["displayCardWitness"] is None


def test_missing_physical_identity_or_witnesses_never_receives_referenced_catalog():
    with client() as c:
        s = new_session(c, "catalogOnly")
        stored = c.app.state.sessions[s["sessionId"]]
        stored.update(state="fabric", cameraProfile={"status": "referenced", "matrix": [[1.,0.,0.], [0.,1.,0.], [0.,0.,1.]], "fingerprint": "settings-1"})
        activate_camera(c, s)
        captured = frames("unwitnessed")
        url = "/api/sessions/" + s["sessionId"]
        r = c.post(url + "/measurements", headers=auth(s), json={"frames": captured, "region": region(), "sourceColorSpace": "srgb",
            "sourceCaptureIds": [f["id"] for f in captured], "capturedAt": "now"})
        assert r.status_code == 200, r.text
        assert r.json()["catalogStatus"] == "exploratory"
        assert r.json()["provenance"] == "exploratoryLive"
        assert "freshPhysicalWitnessesMissing" in r.json()["approvalLimitations"]


def test_literal_fields_do_not_coerce_boolean_and_integer():
    with client() as c:
        s = new_session(c)
        url = "/api/sessions/" + s["sessionId"]
        assert c.post(url + "/reference", json={"exploratory": 1}, headers=auth(s)).status_code == 422
        from colorlab.models import Envelope
        from pydantic import ValidationError
        import pytest
        with pytest.raises(ValidationError):
            Envelope.model_validate({"event": "heartbeat", "protocolVersion": True, "sessionId": s["sessionId"], "messageId": "m", "sequenceId": 1,
                                     "role": "camera", "payload": {"localTime": 0}})
