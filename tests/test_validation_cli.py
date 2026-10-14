import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).parents[1]


def invoke(kind, value):
    return subprocess.run([sys.executable, str(ROOT / "tools/validation_report.py"), kind], input=json.dumps(value), text=True, capture_output=True, timeout=30, cwd=ROOT)


def test_cli_outputs_a_report_without_touching_the_original():
    value = {"samples": [{"captureId": f"c{i}", "placementId": f"p{i}", "lab": [50, 1, 2]} for i in range(10)], "referenceWhite": "D65", "observer": "2"}
    before = json.dumps(value)
    result = invoke("repeatability", value)
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["independentValidationStatus"] == "notTested"
    assert report["physicalEvidenceVerifiedBySoftware"] is False
    assert json.dumps(value) == before


def test_cli_rejects_missing_source_and_bad_payload():
    result = invoke("instrument", {"estimate": {}, "reading": {}})
    assert result.returncode != 0
    assert "Invalid operator report" in result.stderr
