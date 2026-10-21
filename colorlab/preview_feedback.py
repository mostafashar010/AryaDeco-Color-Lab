"""Bounded, session-relative camera feedback; never catalog color validation."""
import numpy as np
from scipy.spatial import Delaunay

from .engine import MATRICES, _encoded, _linear

# The camera path is 8-bit encoded video. When every channel of the observed band is within
# this many code values of its target, the difference cannot be told apart from quantization
# and sensor noise, and moving the display drive for it only makes the preview jitter. It is
# the same 2/255 that the live-preview endpoint already uses to decide that a re-sent target
# is unchanged. Nominal, not a measured sensor noise floor.
NOISE_DEADBAND_CODES = 2


def _noise_tolerance(observed, codes):
    """Per-channel linear-light half-width of `codes` 8-bit code values around `observed`.

    Level aware by construction: one code is a few 1e-4 near black and several 1e-3 in the
    mid-tones, so a fixed linear threshold would either hide real near-black error or let
    mid-tone noise through.
    """
    if codes <= 0:
        return np.zeros(3)
    encoded = _encoded(observed)
    step = codes / 255
    return (_linear(np.clip(encoded + step, 0, 1)) - _linear(np.clip(encoded - step, 0, 1))) / 2


def correct_band(drive, target, observed, profile=None, previous=None, *, deadband_codes=NOISE_DEADBAND_CODES):
    drive, target, observed = map(lambda value: np.asarray(value, dtype=float), (drive, target, observed))
    error = target - observed
    residual = float(np.linalg.norm(error))
    # Nominal dark 8-bit half-LSB RGB norm, not a measured sensor noise floor.
    noise_floor = np.sqrt(3) / (2 * 255 * 12.92)
    previous_residual = previous.get("residualBefore", residual) if previous else residual
    progress_threshold = max(1e-12, .01 * previous_residual)
    # Within camera noise on every channel: hold the drive, and never call that a plateau.
    within_noise = bool(np.all(np.abs(error) <= _noise_tolerance(observed, deadband_codes)))
    stalled = (previous.get("stalledIterations", 0) + 1 if previous and residual > noise_floor
               and previous_residual - residual < progress_threshold and not within_noise else 0)
    method = "nominalTransferDampedFeedback"
    supported = bool(profile and profile.get("validProfile")
                     and Delaunay(profile["trainingDrives"]).find_simplex(drive, tol=1e-8) >= 0)
    if supported:
        parameters = np.asarray(profile["parameters"])
        gamma = parameters[12:15]
        jacobian = parameters[:9].reshape(3, 3) @ np.diag(gamma * np.maximum(drive, .02) ** (gamma - 1))
        if profile["nativeCanvasColorSpace"] != "srgb":
            jacobian = MATRICES[profile["nativeCanvasColorSpace"]] @ jacobian
            jacobian = np.linalg.inv(MATRICES["srgb"]) @ jacobian
        method = "measuredResponseJacobianFeedback"
    else:
        derivative = np.where(drive <= .04045, 1 / 12.92,
                              2.4 / 1.055 * ((drive + .055) / 1.055) ** 1.4)
        jacobian = np.diag(derivative)
    # Ridge damping limits amplification around dark or weakly observed channels.
    delta = np.linalg.solve(jacobian.T @ jacobian + .0025 * np.eye(3), jacobian.T @ error)
    damping = .5 / (1 + min(stalled, 4))
    proposed = drive + np.clip(damping * delta, -.08, .08)
    bounded = np.clip(proposed, 0, 1)
    # `saturated` keeps describing the unconstrained proposal, as before the deadband existed.
    held = np.clip(drive, 0, 1) if within_noise else bounded
    return {"drive": held.tolist(), "status": "measuredFeedbackExperimental", "method": method,
            "residualBefore": residual, "residualAfter": None, "stalledIterations": stalled,
            "saturated": bool(np.any(proposed != bounded)), "physicalAccuracyVerified": False,
            "warnings": (["displayDriveSaturated"] if np.any(proposed != bounded) else [])
                        + (["previewFeedbackPlateau"] if stalled >= 3 else [])
                        + (["withinCameraNoiseDeadband"] if within_noise else [])
                        + (["response_out_of_support"] if profile and not supported else [])}


def same_targets(previous, bands, mapping, fingerprint, canvas_space, appearance_space="srgb", *, encoded_tolerance=None):
    if (not previous or previous.get("layout") != "liveBands" or previous.get("mapping") != mapping
            or previous.get("fingerprint") != fingerprint or previous.get("canvasColorSpace") != canvas_space
            or previous.get("cameraAppearanceColorSpace", "srgb") != appearance_space):
        return False
    old = previous.get("cameraAppearanceBands", [])
    if len(old) != len(bands):
        return False
    return all(a["id"] == b["id"] and abs(a["top"] - b["top"]) <= .015
               and abs(a["bottom"] - b["bottom"]) <= .015
               and np.linalg.norm(_linear(a["drive"]) - _linear(b["drive"])) <= .08
               and (encoded_tolerance is None or np.max(np.abs(np.asarray(a["drive"]) - b["drive"])) <= encoded_tolerance)
               for a, b in zip(old, bands))


def band_raster_bound(roi, width, height, top, bottom):
    points = np.asarray(roi, dtype=float) * [width, height]
    if len(points) == 4:
        # Same four-corner interpolation used by the preview sampler. Bound the
        # full band, not its smaller inset, allowing fractional raster edges.
        tl, tr, br, bl = points
        points = np.array([tl + top * (bl - tl), tr + top * (br - tr),
                           tr + bottom * (br - tr), tl + bottom * (bl - tl)])
    else:
        low, high = points.min(axis=0), points.max(axis=0)
        y0, y1 = low[1] + top * (high[1] - low[1]), low[1] + bottom * (high[1] - low[1])
        points = np.array([[low[0], y0], [high[0], y0], [high[0], y1], [low[0], y1]])
    area = abs(np.dot(points[:, 0], np.roll(points[:, 1], 1))
               - np.dot(points[:, 1], np.roll(points[:, 0], 1))) / 2
    perimeter = np.linalg.norm(points - np.roll(points, 1, axis=0), axis=1).sum()
    bbox = np.prod(np.ceil(points.max(axis=0)) - np.floor(points.min(axis=0)))
    return int(min(256, bbox, np.ceil(area + perimeter / np.sqrt(2) + np.pi / 2)))
