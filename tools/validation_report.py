"""Read operator JSON from stdin, print a validation report without changing measurements."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from colorlab.validation import instrument_report, reacquisition_report, repeatability_report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("repeatability", "reacquisition", "instrument"))
    options = parser.parse_args()
    # Input is explicit; no folder crawling or discovery of private images.
    raw = sys.stdin.read(2_000_001)
    if len(raw.encode("utf-8")) > 2_000_000:
        raise SystemExit("Input exceeds 2MB bound")
    try:
        payload = json.loads(raw)
        if options.kind == "repeatability":
            report = repeatability_report(payload["samples"], white=payload["referenceWhite"], observer=payload["observer"])
        elif options.kind == "reacquisition":
            report = reacquisition_report(payload["original"], payload["observed"], capture_id=payload["captureId"], white=payload["referenceWhite"], observer=payload["observer"])
        else:
            report = instrument_report(payload["estimate"], payload["reading"])
        print(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2))
    except (ValueError, KeyError, TypeError) as exc:
        raise SystemExit(f"Invalid operator report: {exc}") from exc


if __name__ == "__main__":
    main()
