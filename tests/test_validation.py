import importlib
import pytest


def validation():
    if importlib.util.find_spec("colorlab.validation") is None:
        pytest.fail("Independent validation report module has not been implemented")
    return importlib.import_module("colorlab.validation")


def test_repeatability_requires_ten_independent_placements_not_adjacent_frames():
    samples = [{"captureId": f"capture-{i}", "placementId": "same-placement", "lab": [50, 2, 3]} for i in range(10)]
    with pytest.raises(ValueError, match="independent"):
        validation().repeatability_report(samples, white="D65", observer="2")


def test_repeatability_reports_stats_without_claiming_accuracy():
    samples = [{"captureId": f"capture-{i}", "placementId": f"placement-{i}", "lab": [50 + i / 10, 2, 3]} for i in range(10)]
    report = validation().repeatability_report(samples, white="D65", observer="2")
    assert report["type"] == "repeatability"
    assert report["independentValidationStatus"] == "notTested"
    assert report["independentPlacements"] == 10
    assert report["statistics"]["median"] > 0
    assert report["statistics"]["max"] >= report["statistics"]["p95"]
    assert report["statistics"]["p95"] >= report["statistics"]["mean"]
    assert report["perCapture"][0]["lab"] == samples[0]["lab"]


def test_reacquisition_preserves_original_holdout_identity_and_errors():
    first = {"patch-a": [50, 2, 3], "patch-b": [70, 1, -1]}
    later = {"patch-a": [51, 2, 3], "patch-b": [69, 1, -1]}
    report = validation().reacquisition_report(first, later, capture_id="independent-reacquisition-1", white="D65", observer="2")
    assert {item["patchId"] for item in report["perPatch"]} == {"patch-a", "patch-b"}
    assert report["referenceKind"] == "originalEstimateNotInstrument"
    assert report["independentValidationStatus"] == "notTested"
    assert report["perPatch"][0]["originalLab"] == first["patch-a"]
    assert report["perPatch"][0]["observedLab"] == later["patch-a"]
    with pytest.raises(ValueError):
        validation().reacquisition_report(first, {"other": [50, 2, 3]}, capture_id="bad", white="D65", observer="2")


def test_instrument_input_requires_actual_source_and_compatible_conditions():
    estimate = {"lab": [50, 2, 3], "referenceWhite": "D65", "observer": "2", "geometry": "45:0", "background": "matte white", "layers": 1, "measurementId": "synthetic-measurement", "measurementVersion": 1}
    instrument = {"lab": [51, 2, 3], "referenceWhite": "D50", "observer": "2", "geometry": "45:0", "background": "matte white", "layers": 1, "instrumentId": "real-id", "measuredAt": "2026-10-12T12:00:00Z", "method": "operator imported physical reading", "source": "test synthetic fixture", "physicalMeasurementConfirmed": True}
    with pytest.raises(ValueError, match="compatible"):
        validation().instrument_report(estimate, instrument)
    instrument["referenceWhite"] = "D65"
    instrument["physicalMeasurementConfirmed"] = False
    with pytest.raises(ValueError, match="confirmed"):
        validation().instrument_report(estimate, instrument)
    instrument["physicalMeasurementConfirmed"] = True
    report = validation().instrument_report(estimate, instrument)
    assert report["instrumentDeltaE00"] > 0
    assert report["independentValidationStatus"] == "operatorSupplied"
    assert report["physicalEvidenceVerifiedBySoftware"] is False
    assert report["estimate"]["lab"] == estimate["lab"]


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_validation_rejects_nonfinite_values(value):
    samples = [{"captureId": f"c-{i}", "placementId": f"p-{i}", "lab": [value, 0, 0]} for i in range(10)]
    with pytest.raises(ValueError):
        validation().repeatability_report(samples, white="D65", observer="2")


def test_repeatability_rejects_null_and_whitespace_ids_and_nonobjects():
    samples = [{"captureId": f"c-{i}", "placementId": f"p-{i}", "lab": [50, 0, 0]} for i in range(10)]
    for invalid in (None, " ", 12):
        samples[0]["captureId"] = invalid
        with pytest.raises(ValueError):
            validation().repeatability_report(samples, white="D65", observer="2")
    with pytest.raises(ValueError):
        validation().repeatability_report(["invalid"] * 10, white="D65", observer="2")


def test_instrument_rejects_empty_geometry_background_and_nonpositive_layers():
    for field, value in (("geometry", ""), ("background", " "), ("layers", 0), ("layers", True), ("layers", 1.5)):
        estimate = {"lab": [50, 0, 0], "referenceWhite": "D65", "observer": "2", "geometry": "45:0", "background": "matte white", "layers": 1}
        reading = {**estimate, "instrumentId": "id", "measuredAt": "2026-10-12T12:00:00Z", "method": "synthetic-test-fixture", "source": "fixture", "physicalMeasurementConfirmed": True}
        estimate[field] = reading[field] = value
        with pytest.raises(ValueError):
            validation().instrument_report(estimate, reading)


def test_instrument_report_requires_source_measurement_identity_and_version():
    estimate = {"lab": [50, 0, 0], "referenceWhite": "D65", "observer": "2", "geometry": "45:0", "background": "matte white", "layers": 1}
    reading = {**estimate, "instrumentId": "id", "measuredAt": "2026-10-12T12:00:00Z", "method": "synthetic-test-fixture", "source": "fixture", "physicalMeasurementConfirmed": True}
    with pytest.raises(ValueError, match="measurement"):
        validation().instrument_report(estimate, reading)
    estimate["measurementId"] = "m1"
    estimate["measurementVersion"] = 1
    report = validation().instrument_report(estimate, reading)
    assert report["estimate"]["measurementId"] == "m1"
    assert report["estimate"]["measurementVersion"] == 1
