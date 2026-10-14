# Requirement Ledger

This ledger defines acceptance and honest exclusions. Implementation and test status must be read together with `TEST_REPORT.md`; this document alone is not evidence of passing.

| Requirement | Acceptance evidence |
|---|---|
| Two real roles, not a mock color picker | Actual browser camera path, role-specific authenticated WS, actual flat display patch and protocol tests |
| Step zero before calibration | Pairing, capabilities/requested/settings distinction, fresh stable multi-frame sample |
| Camera -> display -> fabric | Server stage gate; wrong-order request rejected; catalog-only/replay explicit separate mode |
| Valid physical references never invented | Reference provenance/schema; empty template unverified; neutral-only exploratory; observer/white supported explicitly |
| Camera fitting | Linear-domain regularized 3x3 baseline, rank/coverage and held-out physical IDs, separate errors; reference-free estimate not absolute calibration |
| Display characterization | Actual commanded patches observed with same physical cards; witness stability and contamination; separate holdout; profile explicitly camera-referenced |
| Conditional profile reuse | Recorded settings fingerprint, cascade invalidation, disconnect pause, display-only change preserves catalog provenance |
| Multiple fabric samples | Ordered region IDs, normalized polygons/exclusions; close colors never implicitly merged; editable band proposal |
| Statistical extraction | Native-source multi-block/multi-frame measurements; clipping/undersize/stale/instability rejection; representative color accompanied by spread/provenance |
| ICC and P3 | Original supplied JPG hashes/profiles verified; synthetic equivalent-color test; unknown ICC behavior; no silent double conversion/clamp |
| Loop | Server owns bounded evaluations and termination; marker ACK/freshness/witness gate; best drive stored independently of catalog |
| Single/group rendering | Actual distinct opaque flat cards; group status separate from single; no claim that single fit proves group |
| Output | Server-generated JSON/CSV, independent statuses, full provenance, failed sample preservation, approved vs experimental distinction |
| Schema | Versioned named domain entities, event envelope and message shapes, exported artifact validation |
| Privacy | Local private session data, no camera video streaming, explicit full-image upload, no production writes, role permissions, deletion |
| HTTPS | Exact Origin, trusted-cert operator guide, safe default loopback, no public deployment claim |
| Validation | Software, synthetic response and original-image parsing separated from real-device/instrument experiments |

## Not Implicitly Available

Physical cards and valid reference tables, RAW access, verified exposure/AWB lock, measured illuminant, OS brightness control, absolute luminance, phone/display model, actual spectrophotometer and compatibility are unknown until supplied/tested. Web APIs cannot make them exist.

## Acceptance Still Requires a Human/Device

Human-confirmed segmentation annotations; hardware sessions on both phones; independent reacquisition from holdout cards; ten truly independent sample placements; contamination controls under real light; device compatibility; instrument-validation data. Test fixtures cannot satisfy these human/device requirements. Editable AI annotation drafts are marked unconfirmed, and no measured physical HEX is certified from the supplied photographs.

## Additional Guardrails

Minimum 10 adjacent unique frames is a capture stability check, not 10 independent experimental repetitions. Camera-domain noise targets and ΔE are not interchangeable. Sparse RGB samples do not establish spatial blur unless neighboring pixels are explicitly examined; unassessed checks must remain visible. Display response mismatch is not automatically out-of-gamut. Independent-validation status remains `notTested` unless actual instrument measurements are supplied through a supported provenance-bearing path.

Training-domain enforcement in this baseline uses conservative convex-hull coverage for camera values. It can reject usable unseen colors rather than extrapolate without warning. Physical card polygons also use conservative disjoint bounding-box checks; separately rotated/nonrectangular patches whose boxes overlap may need smaller interior ROIs. These are explicit fail-closed constraints, not proof of laboratory accuracy.

## Delivery Boundary

Native hardware RAW, external instrument drivers, public multi-tenant hosting, long-lived production persistence, spectral/material BRDF modeling and automatic proof of firmware locks are outside this local baseline. A missing implementable workflow must be recorded as incomplete, not relabeled future scientific impossibility. `TEST_REPORT.md` lists actual remaining gaps explicitly.

Final named implementable gaps: automatic known-card localization/rotation mapping, physical grouped-patch verification workflow, independent patterned-component representative approval UI. The absence of these features means the entire master specification is not claimed complete. Manual ROI/reference binding, true simultaneous group rendering with explicit unverified status, and experimental component statistics are delivered alternatives, not equivalents of the missing acceptance criteria.
