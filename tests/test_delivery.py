import json
import csv
import io
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).parents[1]


def test_frozen_schema_is_valid_json_and_covers_entities():
    path = ROOT / "schemas" / "colorlab-v1.schema.json"
    assert path.is_file(), "Delivery must include a versioned, inspectable schema file"
    schema = json.loads(path.read_text())
    assert schema["protocolVersion"] == 1
    assert {"Session", "DeviceCapabilityReport", "ReferenceTarget", "CameraProfile", "DisplayCompensationProfile", "Capture", "SampleRegion", "Measurement", "MatchRun", "ValidationReport"} <= set(schema["entities"])
    assert "events" in schema


def test_artifacts_are_real_json_and_csv_not_empty_placeholders():
    for name in ("replay-srgb.json", "replay-p3.json"):
        path = ROOT / "examples" / name
        assert path.is_file(), "Generate actual replay export artifacts from the API"
        report = json.loads(path.read_text())
        assert report["measurements"]
        assert report["independentValidationStatus"] == "notTested"
        assert report["exportKind"] == "experimental"
        assert all(item["instrumentDeltaE00"] is None for item in report["measurements"])
        assert all(item["displayDriveRgb"] is None for item in report["measurements"])
    assert (ROOT / "examples" / "replay-p3.csv").read_text().count("\n") >= 2


def test_reference_drafts_do_not_pretend_to_be_human_annotations():
    paths = list((ROOT / "references").glob("*.json"))
    assert paths, "References must have editable, explicitly unconfirmed annotation drafts"
    annotations = [json.loads(path.read_text()) for path in paths]
    assert any("humanConfirmed" in item for item in annotations)
    assert all(not item.get("humanConfirmed", False) for item in annotations)


def test_measurement_export_artifacts_validate_against_declared_entity_schema():
    schema = json.loads((ROOT / "schemas/colorlab-v1.schema.json").read_text())
    entity = schema["entities"]["Measurement"]
    Draft202012Validator.check_schema(entity)
    validator = Draft202012Validator(entity)
    for filename in ("replay-srgb.json", "replay-p3.json"):
        report = json.loads((ROOT / "examples" / filename).read_text())
        for measurement in report["measurements"]:
            errors = list(validator.iter_errors(measurement))
            assert not errors, "\n".join(error.message for error in errors)


def test_failed_reference_extractions_remain_in_report_without_invented_hex():
    report = json.loads((ROOT / "examples/replay-srgb.json").read_text())
    rejected = [sample for sample in report["measurements"] if sample["captureQuality"] == "rejected"]
    assert rejected, "Actual nonuniform/carpet/translucent image draft failures must remain visible"
    assert all(sample["catalogHexSrgb"] is None for sample in rejected)
    assert all(sample["quality"]["warnings"] for sample in rejected)


def test_experimental_exports_preserve_image_decode_provenance():
    report = json.loads((ROOT / "examples/replay-p3.json").read_text())
    capture_ids = {capture["id"] for capture in report["captures"]}
    assert capture_ids
    assert all(set(item["sourceCaptureIds"]) <= capture_ids for item in report["measurements"])
    p3 = report["captures"][0]
    assert p3["metadata"]["originalSha256"] == "ae19fc687b927e4af8362add615a6667a14ff5106a628189937811318b92c2e2"
    assert p3["metadata"]["sourceColorSpace"] == "display-p3"
    assert "rgb" not in p3, "Full array is not silently exported into report"


def test_csv_and_json_preserve_all_sample_identities_and_independent_color_fields():
    for slug in ("srgb", "p3"):
        report = json.loads((ROOT / "examples" / f"replay-{slug}.json").read_text())
        rows = list(csv.DictReader(io.StringIO((ROOT / "examples" / f"replay-{slug}.csv").read_text())))
        assert len(rows) == len(report["measurements"])
        assert {row["measurementId"].removeprefix("'") for row in rows} == {sample["id"] for sample in report["measurements"]}
        assert all(row["instrumentDeltaE00"] in ("", "null") for row in rows)
        assert all(row["independentValidationStatus"] == "notTested" for row in rows)
        assert all(row["displayDriveRgb"] in ("", "null") for row in rows)


def test_editable_swatch_drafts_preserve_eleven_interiors_and_partial_terminal():
    annotation = json.loads((ROOT / "references/02-swatch-bands.annotations.json").read_text())
    assert len(annotation["regions"]) == 11
    assert [region["order"] for region in annotation["regions"]] == list(range(11))
    assert all(region["exclusions"] for region in annotation["regions"])
    assert annotation["terminalPartialRegion"]["operatorConfirmed"] is False
    assert annotation["terminalPartialRegion"]["completeSample"] is False


def test_sheer_annotation_is_conservative_and_excludes_label_and_carpet():
    annotation = json.loads((ROOT / "references/01-striped-sheer.annotations.json").read_text())
    assert annotation["regions"]
    for region in annotation["regions"]:
        assert max(vertex[0] for vertex in region["polygon"]) <= 0.72
        assert min(vertex[1] for vertex in region["polygon"]) >= 0.28
        assert region["exclusions"]
