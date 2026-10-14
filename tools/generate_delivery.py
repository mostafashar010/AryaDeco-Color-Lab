"""Generate inspectable schema and experimental exports through the real API.

This is replay of supplied photographs, never a hardware color measurement.
No network/production connection, and no tokens are written to artifacts.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient
from colorlab.app import app


def check(response):
    if response.status_code not in (200, 201):
        raise RuntimeError(f"API {response.status_code}: {response.text[:1000]}")
    return response.json()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Write local schemas and experimental example exports")
    options = parser.parse_args()
    artifacts = {}
    with TestClient(app) as client:
        artifacts["schemas/colorlab-v1.schema.json"] = json.dumps(check(client.get("/api/schema")), ensure_ascii=False, indent=2) + "\n"
        for filename, slug in (("01-striped-sheer.jpg", "srgb"), ("02-swatch-bands.jpg", "p3")):
            created = check(client.post("/api/sessions", json={"mode": "replay", "conditions": {"purpose": "actual-image replay, not physical validation"}}, headers={"Origin": "http://localhost:8443"}))
            headers = {"Authorization": f"Bearer {created['cameraToken']}", "Origin": "http://localhost:8443"}
            base = f"/api/sessions/{created['sessionId']}"
            path = ROOT / "references" / filename
            uploaded = check(client.post(base + "/images", headers=headers, files={"file": (filename, path.read_bytes(), "image/jpeg")}, data={"retention": "false"}))
            annotation = json.loads((path.with_suffix(".annotations.json")).read_text())
            if annotation["humanConfirmed"] or annotation["colorGroundTruth"]:
                raise RuntimeError("Generator must not claim the draft as confirmed human/color truth")
            regions = annotation["regions"]
            check(client.post(base + f"/images/{uploaded['captureId']}/regions", headers=headers, json={"regions": regions}))
            report = check(client.get(base + "/export?format=json&kind=experimental", headers=headers))
            # Annotate the experimental artifact's purpose, without inventing validation.
            report["artifactPurpose"] = "imageReplayOnlyNotPhysicalValidation"
            report["humanAnnotationStatus"] = "pending"
            report["annotationSource"] = annotation["annotationSource"]
            text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
            if created["cameraToken"] in text or created["displayToken"] in text:
                raise RuntimeError("Export leaked a session token")
            artifacts[f"examples/replay-{slug}.json"] = text
            csv_response = client.get(base + "/export?format=csv&kind=experimental", headers=headers)
            if csv_response.status_code != 200:
                raise RuntimeError(csv_response.text)
            artifacts[f"examples/replay-{slug}.csv"] = csv_response.text
            check(client.delete(base, headers=headers))
    for filename, content in artifacts.items():
        if options.write:
            path = ROOT / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        print(f"{'Wrote' if options.write else 'Verified'} {filename}: {len(content.encode('utf-8'))} bytes")


if __name__ == "__main__":
    main()
