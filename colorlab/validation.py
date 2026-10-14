"""Provenance-bearing operator reports. Software cannot authenticate physical evidence."""

from datetime import datetime, timezone

import numpy as np
from colour.difference import delta_E_CIE2000


def _lab(value):
    result = np.asarray(value, dtype=float)
    if result.shape != (3,) or not np.isfinite(result).all() or not 0 <= result[0] <= 100 or np.any(np.abs(result[1:]) > 200):
        raise ValueError("Lab must be finite [L=0..100, a,b=-200..200]")
    return result


def _domain(white, observer):
    if white not in ("D50", "D65") or observer != "2":
        raise ValueError("Only declared D50/D65 2-degree Lab is supported")


def _stats(errors):
    values = np.asarray(errors, dtype=float)
    return {"mean": float(np.mean(values)), "median": float(np.median(values)), "p95": float(np.percentile(values, 95)), "max": float(np.max(values))}


def repeatability_report(samples, *, white, observer):
    _domain(white, observer)
    if not isinstance(samples, list) or not 10 <= len(samples) <= 1000 or not all(isinstance(item, dict) for item in samples):
        raise ValueError("At least ten independent placements, up to 1000, are required")
    capture_ids = [item.get("captureId") for item in samples]
    placement_ids = [item.get("placementId") for item in samples]
    if not all(isinstance(value, str) and value.strip() and len(value) <= 200 for value in capture_ids + placement_ids) or len(set(capture_ids)) != len(samples) or len(set(placement_ids)) != len(samples):
        raise ValueError("independent capture and placement identities required, not adjacent frames")
    labs = np.array([_lab(item["lab"]) for item in samples])
    center = np.median(labs, axis=0)
    errors = delta_E_CIE2000(labs, center)
    return {"type": "repeatability", "independentValidationStatus": "notTested", "independentPlacements": len(samples), "domain": {"referenceWhite": white, "observer": observer}, "method": "componentMedianLabAndDE00; operator asserts independent placement identities", "centerLab": center.tolist(), "statistics": _stats(errors), "perCapture": [{"captureId": capture_ids[i], "placementId": placement_ids[i], "lab": labs[i].tolist(), "estimatedDeltaE00": float(errors[i])} for i in range(len(samples))], "physicalEvidenceVerifiedBySoftware": False}


def reacquisition_report(original, observed, *, capture_id, white, observer):
    _domain(white, observer)
    if not isinstance(capture_id, str) or not capture_id.strip() or not isinstance(original, dict) or not isinstance(observed, dict) or not original or set(original) != set(observed) or len(original) > 500:
        raise ValueError("Independent capture ID and exactly matching physical holdout patch IDs required")
    per_patch = [{"patchId": patch, "originalLab": _lab(original[patch]).tolist(), "observedLab": _lab(observed[patch]).tolist(), "estimatedDeltaE00": float(delta_E_CIE2000(_lab(original[patch]), _lab(observed[patch])))} for patch in original]
    return {"type": "independentReacquisition", "captureId": capture_id, "referenceKind": "originalEstimateNotInstrument", "independentValidationStatus": "notTested", "domain": {"referenceWhite": white, "observer": observer}, "perPatch": per_patch, "statistics": _stats([item["estimatedDeltaE00"] for item in per_patch]), "physicalEvidenceVerifiedBySoftware": False}


def instrument_report(estimate, reading):
    fields = ("referenceWhite", "observer", "geometry", "background", "layers")
    if not isinstance(estimate, dict) or not isinstance(reading, dict):
        raise ValueError("Instrument input and estimate must be objects")
    if any(estimate.get(field) is None or estimate.get(field) != reading.get(field) for field in fields):
        raise ValueError("Instrument and estimate must have compatible, explicitly supplied conditions")
    _domain(estimate["referenceWhite"], estimate["observer"])
    if any(not isinstance(estimate[field], str) or not estimate[field].strip() for field in ("geometry", "background")) or type(estimate["layers"]) is not int or not 1 <= estimate["layers"] <= 100:
        raise ValueError("Nonempty geometry/background and positive integer layers required")
    if reading.get("physicalMeasurementConfirmed") is not True:
        raise ValueError("Operator-confirmed physical measurement required; fixture values are not evidence")
    if not isinstance(estimate.get("measurementId"), str) or not estimate["measurementId"].strip() or type(estimate.get("measurementVersion")) is not int or estimate["measurementVersion"] < 1:
        raise ValueError("Source measurement ID and positive measurementVersion required")
    if any(not isinstance(reading.get(field), str) or not reading[field].strip() for field in ("instrumentId", "measuredAt", "method", "source")):
        raise ValueError("Actual instrument identity, source, time and method required")
    try:
        measured = datetime.fromisoformat(reading["measuredAt"].replace("Z", "+00:00"))
        if measured.tzinfo is None or measured > datetime.now(timezone.utc):
            raise ValueError("Measurement timestamp must include timezone and not be in the future")
    except (TypeError, ValueError) as exc:
        raise ValueError("Valid actual measurement timestamp required") from exc
    difference = float(delta_E_CIE2000(_lab(estimate["lab"]), _lab(reading["lab"])))
    return {"type": "instrumentComparison", "instrumentDeltaE00": difference, "independentValidationStatus": "operatorSupplied", "physicalEvidenceVerifiedBySoftware": False, "conditions": {field: reading[field] for field in fields}, "estimate": {**estimate, "lab": _lab(estimate["lab"]).tolist()}, "instrumentReading": {field: reading[field] for field in (*fields, "instrumentId", "measuredAt", "method", "source", "lab")}, "warning": "Operator-supplied reading; no instrument driver or independent attestation"}
