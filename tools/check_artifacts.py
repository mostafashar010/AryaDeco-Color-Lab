"""Offline schema validation of report artifacts; never physical color validation."""

import json
from pathlib import Path

from jsonschema import Draft202012Validator


def main():
    root = Path(__file__).resolve().parents[1]
    schema = json.loads((root / "schemas/colorlab-v1.schema.json").read_text())
    validator = Draft202012Validator(schema["entities"]["Measurement"])
    for path in sorted((root / "examples").glob("replay-*.json")):
        report = json.loads(path.read_text())
        for measurement in report["measurements"]:
            validator.validate(measurement)
            if measurement["instrumentDeltaE00"] is not None:
                raise ValueError("Replay artifact cannot contain a physical instrument reading")
            if measurement["displayDriveRgb"] is not None:
                raise ValueError("Replay artifact cannot contain a physical display match")
        print(f"Validated {path.name}: {len(report['measurements'])} image-only sample reports")


if __name__ == "__main__":
    main()
