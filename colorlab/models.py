import math
from typing import Annotated, Literal, get_args, get_origin

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    @model_validator(mode="before")
    @classmethod
    def bounded_json(cls, value):
        if isinstance(value, dict):
            for name, field in cls.model_fields.items():
                if name in value and get_origin(field.annotation) is Literal:
                    options = get_args(field.annotation)
                    if not any(type(value[name]) is type(option) and value[name] == option for option in options):
                        raise ValueError("strict_literal_type_required")
        def walk(item, depth=0):
            if depth > 12:
                raise ValueError("json_nesting_limit")
            if isinstance(item, float) and not math.isfinite(item):
                raise ValueError("finite_numbers_required")
            if isinstance(item, str) and len(item) > 4096:
                raise ValueError("string_limit")
            if isinstance(item, dict):
                if len(item) > 256 or any(not isinstance(k, str) or len(k) > 128 for k in item):
                    raise ValueError("object_limit")
                for child in item.values():
                    walk(child, depth + 1)
            elif isinstance(item, list):
                if len(item) > 8192:
                    raise ValueError("list_limit")
                for child in item:
                    walk(child, depth + 1)
        walk(value)
        return value


class SessionCreate(StrictModel):
    mode: Literal["threeStage", "catalogOnly", "replay", "cameraMatch"]
    conditions: dict[str, JsonValue] = Field(max_length=32)
    diagnosticsEnabled: bool = True


class Conditions(StrictModel):
    conditions: dict[str, JsonValue] = Field(max_length=32)


Unit = Annotated[float, Field(ge=0, le=1)]
Finite = Annotated[float, Field(ge=-1e12, le=1e12)]
Name = Annotated[str, Field(min_length=1, max_length=128)]
RGB = Annotated[list[Unit], Field(min_length=3, max_length=3)]


class Envelope(StrictModel):
    event: Name
    protocolVersion: Literal[1]
    sessionId: Name
    messageId: Name
    sequenceId: Annotated[int, Field(ge=1, le=2147483647)]
    role: Literal["camera", "display", "server"]
    payload: dict[str, JsonValue]


class Join(StrictModel):
    token: Annotated[str, Field(min_length=32, max_length=128)]


class Capabilities(StrictModel):
    browserSupported: bool
    trackCapabilities: dict[str, JsonValue]
    requested: dict[str, JsonValue]
    reportedSettings: dict[str, JsonValue]
    controlStatus: dict[str, JsonValue]
    supportedConstraints: dict[str, JsonValue] = Field(default_factory=dict, max_length=128)
    deviceLabel: Annotated[str, Field(max_length=256)]
    capturePath: Annotated[str, Field(max_length=128)]
    canvasColorSpace: Literal["srgb", "display-p3", "unknown"]
    wakeLock: bool


class GroupPatch(StrictModel):
    sampleId: Name
    drive: RGB


class LiveBand(StrictModel):
    id: Name
    drive: RGB
    top: Unit
    bottom: Unit

    @model_validator(mode="after")
    def nonempty(self):
        if self.top >= self.bottom:
            raise ValueError("nonempty_band_required")
        return self


class PreviewSourceFrame(StrictModel):
    mediaTime: Annotated[float, Field(ge=0, le=1e12)]
    presentedFrames: Annotated[int, Field(ge=0, le=1000000000)]
    width: Annotated[int, Field(ge=1, le=12000)]
    height: Annotated[int, Field(ge=1, le=12000)]


class PreviewBandObservation(StrictModel):
    id: Name
    rgb: RGB
    validPixels: Annotated[int, Field(ge=16, le=256)]
    validBlocks: Annotated[int, Field(ge=4, le=8192)]
    blockSpread: Annotated[float, Field(ge=0, le=.08)]
    clippedRate: Annotated[float, Field(ge=0, le=.02)]

    @model_validator(mode="after")
    def block_density(self):
        if self.validBlocks * 4 > self.validPixels:
            raise ValueError("preview_feedback_block_density_invalid")
        return self


class PreviewFeedback(StrictModel):
    commandSequence: Annotated[int, Field(ge=1, le=16777215)]
    patchId: Name
    markerPixels: list[RGB] = Field(min_length=28, max_length=28)
    screenRoi: Annotated[list[Annotated[list[Unit], Field(min_length=2, max_length=2)]], Field(min_length=3, max_length=128)]
    stable: Literal[True]
    screenAppearanceBands: list[PreviewBandObservation] = Field(min_length=1, max_length=32)


class LivePreview(StrictModel):
    streamId: Annotated[str, Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
    bands: list[LiveBand] = Field(min_length=1, max_length=32)
    mapping: Literal["screenAligned", "orderedPreview"]
    sourceFrame: PreviewSourceFrame
    fingerprint: Annotated[str, Field(min_length=1, max_length=128)] | None = None
    canvasColorSpace: Literal["srgb", "display-p3"] | None = None
    cameraAppearanceColorSpace: Literal["srgb", "display-p3"] = "srgb"
    compensatedOnly: bool = False
    feedback: PreviewFeedback | None = None
    warnings: list[Literal["partialBand", "orderedPreview", "screenAlignmentUncertain", "cameraControlsUnknown", "uncalibratedPreview", "mediaClockUnavailable"]] = Field(max_length=16)

    @model_validator(mode="after")
    def ordered(self):
        if len({b.id for b in self.bands}) != len(self.bands):
            raise ValueError("unique_band_ids_required")
        if any(a.bottom > b.top for a, b in zip(self.bands, self.bands[1:])):
            raise ValueError("ordered_nonoverlapping_bands_required")
        return self


DiagnosticCount = Annotated[int, Field(ge=0, le=1000000000)]
DiagnosticSequence = Annotated[int, Field(ge=1, le=16777215)]
DiagnosticDimension = Annotated[int, Field(ge=1, le=12000)]
DiagnosticPolygon = Annotated[list[Annotated[list[Unit], Field(min_length=2, max_length=2)]], Field(min_length=3, max_length=8)]
DiagnosticRejection = Literal["cameraShadowClipped", "cameraHighlightClipped", "spatiallyMixed", "insufficientPixels", "insufficientBlocks", "invalidBand", "invalidImage", "markerMissing", "markerMismatch", "screenApertureMissing", "screenGeometryUncertain", "commandNotRendered", "geometryUnstable", "cameraMoving", "targetChanged", "colorSpaceMismatch", "bandLayoutMismatch"]


class DiagnosticQuality(StrictModel):
    status: Literal["accepted", "rejected", "notAssessed", "previewOnly", "measured"]
    validPixels: Annotated[int, Field(ge=0, le=100000000)] | None = None
    validBlocks: Annotated[int, Field(ge=0, le=8192)] | None = None
    blockSpread: Unit | None = None
    clippedRate: Unit | None = None
    shadowClippedRate: Unit | None = None
    highlightClippedRate: Unit | None = None


class DiagnosticBand(StrictModel):
    bandIndex: Annotated[int, Field(ge=0, le=31)]
    top: Unit | None = None
    bottom: Unit | None = None
    targetRgb: RGB | None = None
    driveRgb: RGB | None = None
    renderedPaintRgb: RGB | None = None
    observedRgb: RGB | None = None
    roi: DiagnosticPolygon | None = None
    quality: DiagnosticQuality | None = None
    residualBefore: Annotated[float, Field(ge=0, le=2)] | None = None
    reasons: list[DiagnosticRejection] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def bounds(self):
        if self.top is not None and self.bottom is not None and self.top >= self.bottom:
            raise ValueError("diagnostic_nonempty_band_required")
        return self


class DiagnosticEvidence(StrictModel):
    role: Literal["camera", "display", "server"]
    stage: Literal["intended", "rendered", "decoded", "sampled", "feedbackAccepted", "rejected"]
    commandSequence: DiagnosticSequence | None = None
    markerSequence: DiagnosticSequence | None = None
    observedCommandSequence: DiagnosticSequence | None = None
    presentedFrames: DiagnosticCount | None = None
    rawMediaTime: Annotated[float, Field(ge=0, le=1e12)] | None = None
    nativeWidth: DiagnosticDimension | None = None
    nativeHeight: DiagnosticDimension | None = None
    analysisWidth: DiagnosticDimension | None = None
    analysisHeight: DiagnosticDimension | None = None
    mapping: Literal["screenAligned", "orderedPreview"] | None = None
    layout: Literal["single", "group", "liveBands"] | None = None
    colorSpace: Literal["srgb", "display-p3"] | None = None
    targetColorSpace: Literal["srgb", "display-p3"] | None = None
    driveColorSpace: Literal["srgb", "display-p3"] | None = None
    observedColorSpace: Literal["srgb", "display-p3"] | None = None
    rgbEncoding: Literal["encoded", "linear"] | None = None
    displayDriveRgb: RGB | None = None
    renderedPaintRgb: RGB | None = None
    screenRoi: DiagnosticPolygon | None = None
    markerRoi: DiagnosticPolygon | None = None
    markerCells: list[RGB] | None = Field(default=None, max_length=28)
    bands: list[DiagnosticBand] = Field(default_factory=list, max_length=32)
    renderedProof: Literal["twoAnimationFrames"] | None = None
    residualMetric: Literal["linearCameraRgb"] | None = None
    status: Literal["renderRequestOnly", "previewOnly", "measured", "accepted", "rejected", "notAssessed"] | None = None
    physicalAccuracyVerified: Literal[False] | None = None
    rejectionReasons: list[DiagnosticRejection] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def explicit_domains(self):
        if len({band.bandIndex for band in self.bands}) != len(self.bands):
            raise ValueError("diagnostic_unique_band_indices_required")
        rgb_present = self.displayDriveRgb is not None or self.renderedPaintRgb is not None or self.markerCells is not None or any(
            any(getattr(band, field) is not None for field in ("targetRgb", "driveRgb", "renderedPaintRgb", "observedRgb"))
            for band in self.bands)
        if rgb_present and (self.colorSpace is None or self.rgbEncoding is None):
            raise ValueError("diagnostic_rgb_domain_required")
        if any(band.residualBefore is not None for band in self.bands) and self.residualMetric is None:
            raise ValueError("diagnostic_residual_metric_required")
        return self


class DiagnosticMarkerRejections(StrictModel):
    sentinelShapeOrResolution: DiagnosticCount | None = None
    ambiguousCells: DiagnosticCount | None = None
    stripHeightSupport: DiagnosticCount | None = None
    nativeSequenceMismatch: DiagnosticCount | None = None
    nativeCellAmbiguity: DiagnosticCount | None = None
    nativeSentinelEdges: DiagnosticCount | None = None
    analysisCellResolution: DiagnosticCount | None = None
    borderedCellAmbiguity: DiagnosticCount | None = None
    borderedRowSupport: DiagnosticCount | None = None
    markerBorderIncomplete: DiagnosticCount | None = None


class DiagnosticEvent(StrictModel):
    sequence: Annotated[int, Field(ge=1, le=2147483647)]
    elapsedMs: Annotated[float, Field(ge=0, le=1e12)]
    area: Literal["camera", "tracking", "capture", "connection", "api", "workbench", "preview", "server", "diagnostics"]
    event: Literal["opened", "closed", "connecting", "request", "response", "rejected", "networkError", "geometry", "configuration", "baselineReset", "stage", "operation_start", "operation_complete", "operation_error", "measurement_stopped", "batch_complete", "update", "needsFraming", "submitted", "rendered", "skipped", "enabled", "disabled", "created", "expired", "pause", "resume", "joined", "disconnected", "previewOpened", "captureStarted", "evidence", "previewAccepted", "session.state", "display.patch.set", "display.patch.rendered", "quality.alert", "match.iteration", "match.complete", "session.pause", "session.resume", "profile.invalidate", "camera.profile.ready", "reference.set", "measurement.submit", "heartbeat", "unclassified"]
    details: dict[str, JsonValue] = Field(default_factory=dict, max_length=48)

    @model_validator(mode="after")
    def private_details(self):
        numeric = set("width height candidateCount cardCount fabricCount neutralCount markerCandidates motionSamples markerSequence expectedSequence regionCount presentedFrames mediaTime processingMs commandSequence elapsedMs bytes validationErrors sequence matchingTriplets analysisWidth analysisHeight bandCount retryAfterMs".split())
        boolean = set("geometryStable moving pixelMoving surfaceChanged fresh stable retry".split())
        numeric.update("analysisLongEdge frameCallbacks jobsStarted jobsCompleted timeouts resets retries attempt lastFrameAt lastCompletedAt lastReceiptAgeMs reportedMediaTime".split())
        enums = {
            "role": {"camera", "display", "server"},
            "mode": {"threeStage", "catalogOnly", "replay", "cameraMatch"},
            "method": {"GET", "POST", "PATCH", "DELETE", "HEAD"},
            "endpoint": set("session sessions camera-matches camera-matches/observe matches matches/observe camera-profile display-profile response-profile neutral-check reference measurements captures/analyze regions export conditions validations override images live-preview diagnostics diagnostics/summary other".split()),
            "phase": set("reference neutral fabric display cameraMatch camera catalog capture preview standby cameraAppearancePreview unclassified".split()),
            "status": set("ready waiting needsFraming moving unstable lost accepted rejected complete stopped pending error running paused connected disconnected needsNeutralCards unknown unclassified".split()),
            "reason": set("operator_pause page_hidden camera_moved device_disconnected socket_disconnected camera_track_ended camera_selection_changed camera_settings_changed camera_controls_changed canvas_color_space_changed roi_changed automatic_run_interrupted profile_invalidated explicit_new_scene awaiting_devices device_joined backpressure fabric_target_drift conditions_changed display_conditions_changed camera_capabilities_changed display_capabilities_changed deleted unclassified".split()),
            "code": set("unclassified origin_mismatch invalid_token camera_token_required token_expired session_not_found body_too_large invalid_payload request_rate_limit session_request_rate_limit engine_busy fresh_actual_preview_frame_required preview_stream_cycle_required preview_stream_cycle_limit preview_rate_limit match_already_active command_history_limit marker_sequence_exhausted active_owned_camera_and_display_required fresh_rendered_command_required stale_command stale_render fabric_target_drift ambiguous_cards neutral_card_quality_rejected neutral_card_order_ambiguous live_neutral_cards_required neutral_card_geometry_changed co_captured_neutral_cards_required three_distinct_neutral_cards_required quality_rejected session_paused stage_order reused_actual_capture frame_reused measurement_invalidated native_video_roi_provenance_required settings_fingerprint_changed camera_match_target_quality_rejected camera_match_capture_quality_rejected reused_or_overlapping_video_frame duplicate_or_reused_capture diagnostics_disabled diagnostic_sequence_reused".split()),
            "name": {"Error", "AbortError", "TypeError", "NotAllowedError", "NotFoundError", "OverconstrainedError", "unclassified"},
            "mapping": {"screenAligned", "orderedPreview"},
            "timeSource": {"videoMediaTime", "callbackClock"},
        }
        enums["reason"].update("slowProcessing workerTimeout lateDetection workerRetry callbackClock videoStarvation invalidFrame invalidPixels missingCardCandidates multipleCardSets cardSetGeometryOrBrightnessMismatch threeCardCandidates displayMarkerMissing displayApertureMissing unstableFrame".split())
        enums["reason"].update({"response_cancelled", "response_neutral_witness_drift"})
        enums["reason"].update(get_args(DiagnosticRejection))
        enums["reason"].update("responseWitnessSelected multipleResponseWitnesses responseWitnessMissing multipleBandStacks displayMarkerMismatch multipleDisplayMarkers".split())
        enums["code"].update("response_valid_profile_required response_out_of_support response_conditions_or_stream_changed response_server_step_required response_neutral_witness_drift response_normalized_rgb_validation_failed preview_must_pause_before_response".split())
        enums["endpoint"].update("response-profile/start response-profile/observe response-profile/invert".split())
        enums["code"].update("response_native_roi_changed response_relative_capture_quality_rejected".split())
        enums["code"].update("preview_feedback_stale_command preview_feedback_expired preview_feedback_context_changed preview_feedback_marker_mismatch preview_feedback_context_required preview_feedback_band_mismatch preview_feedback_screen_geometry_required preview_feedback_pixel_count_exceeds_native_band".split())
        enums["code"].update("capture_aborted capture_marker_mismatch capture_timeout capture_camera_unavailable capture_geometry_unavailable capture_canvas_unavailable capture_color_space_mismatch capture_settings_changed capture_geometry_unstable capture_unclassified diagnostic_role_mismatch diagnostic_display_render_evidence_required".split())
        enums["code"].update({"capture_frozen_video_clock", "capture_frame_identity_unavailable"})
        for key, value in self.details.items():
            if key == "evidenceSnapshot":
                if self.event not in ("evidence", "previewAccepted"):
                    raise ValueError("diagnostic_evidence_event_required")
                try:
                    self.details[key] = DiagnosticEvidence.model_validate(value).model_dump(exclude_unset=True)
                except ValidationError as exc:
                    # Unknown nested keys are user input, not safe error-location labels.
                    raise ValueError("diagnostic_evidence_invalid") from exc
                continue
            if key == "markerRejections":
                try:
                    self.details[key] = DiagnosticMarkerRejections.model_validate(value).model_dump(exclude_unset=True)
                except ValidationError as exc:
                    raise ValueError("diagnostic_marker_rejections_invalid") from exc
                continue
            if key == "markerSentinels":
                valid = type(value) is int and 0 <= value <= 1000000000
            elif key in numeric:
                valid = type(value) in (int, float) and 0 <= value <= 1e12
            elif key in boolean:
                valid = type(value) is bool
            elif key == "status" and type(value) is int:
                valid = 100 <= value <= 599
            else:
                valid = key in enums and type(value) is str and value in enums[key]
            if not valid:
                raise ValueError("diagnostic_private_or_uncontrolled_field")
        return self


class DiagnosticsInput(StrictModel):
    events: list[DiagnosticEvent] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def client_evidence(self):
        if any(event.event == "previewAccepted" or event.details.get("evidenceSnapshot", {}).get("role") == "server"
               for event in self.events):
            raise ValueError("diagnostic_server_evidence_forbidden")
        return self


class DiagnosticsSettings(StrictModel):
    enabled: bool


class LiveDebugSettings(StrictModel):
    enabled: bool
    consent: bool = False


class LiveDebugMetadata(StrictModel):
    presentedFrames: Annotated[int, Field(ge=0, le=1000000000)] | None = None
    mediaTime: Annotated[float, Field(ge=0, le=1e12)] | None = None
    width: Annotated[int, Field(ge=1, le=12000)] | None = None
    height: Annotated[int, Field(ge=1, le=12000)] | None = None
    imageWidth: Annotated[int, Field(ge=1, le=640)] | None = None
    imageHeight: Annotated[int, Field(ge=1, le=640)] | None = None
    trackingPresentedFrames: Annotated[int, Field(ge=0, le=1000000000)] | None = None
    trackingRawMediaTime: Annotated[float, Field(ge=0, le=1e12)] | None = None
    trackingMatchedFrame: bool | None = None
    phase: Annotated[str, Field(max_length=32)] | None = None
    status: Annotated[str, Field(max_length=32)] | None = None
    cardCount: Annotated[int, Field(ge=0, le=1000000)] | None = None
    candidateCount: Annotated[int, Field(ge=0, le=1000000)] | None = None
    markerCandidates: Annotated[int, Field(ge=0, le=1000000)] | None = None
    fabricCount: Annotated[int, Field(ge=0, le=1000000)] | None = None
    reason: Annotated[str, Field(max_length=64)] | None = None

    @model_validator(mode="after")
    def controlled_values(self):
        if self.trackingMatchedFrame is True and (
                self.presentedFrames is None or self.mediaTime is None
                or self.trackingPresentedFrames != self.presentedFrames
                or self.trackingRawMediaTime != self.mediaTime):
            raise ValueError("live_debug_tracking_frame_mismatch")
        if self.trackingMatchedFrame is False and any(value is not None for value in (
                self.phase, self.status, self.cardCount, self.candidateCount,
                self.markerCandidates, self.fabricCount)):
            raise ValueError("live_debug_uncorrelated_tracking_results")
        DiagnosticEvent.model_validate({"sequence": 1, "elapsedMs": 0., "area": "diagnostics",
                                       "event": "update", "details": self.model_dump(exclude_none=True, exclude={
                                           "imageWidth", "imageHeight", "trackingPresentedFrames",
                                           "trackingRawMediaTime", "trackingMatchedFrame"})})
        return self


class PatchSet(StrictModel):
    profileVersion: Annotated[int, Field(ge=0)]
    patchId: Name
    displayDriveRgb: RGB
    layout: Literal["single", "group"]
    sampleIds: list[Name] = Field(max_length=64)
    patches: list[GroupPatch] | None = Field(default=None, min_length=1, max_length=32)

    @model_validator(mode="after")
    def group(self):
        if self.layout == "group":
            if not self.patches or self.sampleIds != [p.sampleId for p in self.patches] or len(set(self.sampleIds)) != len(self.sampleIds):
                raise ValueError("group_cards_required")
        elif self.patches:
            raise ValueError("single_layout_group_cards_forbidden")
        return self


class Rendered(StrictModel):
    profileVersion: Annotated[int, Field(ge=0)]
    patchId: Name
    commandSequence: Annotated[int, Field(ge=1, le=16777215)]
    renderedAt: Finite


class LiveBandsCommand(LivePreview):
    profileVersion: Annotated[int, Field(ge=0)]
    patchId: Name
    displayDriveRgb: RGB
    layout: Literal["liveBands"]
    purpose: Literal["cameraAppearancePreview"]
    sampleIds: list[Name] = Field(min_length=1, max_length=32)
    commandSequence: Annotated[int, Field(ge=1, le=16777215)]
    markerSequence: Annotated[int, Field(ge=1, le=16777215)]
    rendered: bool
    cameraAppearanceBands: list[LiveBand] | None = None
    compensation: dict[str, JsonValue] | None = None


class Reason(StrictModel):
    reason: Annotated[str, Field(min_length=1, max_length=256)]


class Resume(StrictModel):
    witnessChecked: Literal[True]


class Heartbeat(StrictModel):
    localTime: Finite


Point = Annotated[list[Unit], Field(min_length=2, max_length=2)]
Polygon = Annotated[list[Point], Field(min_length=3, max_length=128)]


class Frame(StrictModel):
    id: Name
    capturedAt: Annotated[float, Field(ge=0, le=1e15)]
    pixels: list[RGB] = Field(min_length=1, max_length=8192)
    colorSpace: Literal["srgb", "display-p3"]
    encoding: Literal["encoded"]
    blockIds: list[Annotated[int, Field(ge=0, le=8192)]] = Field(min_length=1, max_length=8192)
    pixelCount: Annotated[int, Field(ge=1, le=100000000)]
    excludedCount: Annotated[int, Field(ge=0, le=100000000)]
    source: Literal["videoCanvas", "replay"]
    settingsFingerprint: Name
    markerSequence: Annotated[int | None, Field(ge=1, le=16777215)]
    markerPixels: list[RGB] | None = Field(default=None, min_length=28, max_length=28)
    presentedFrames: Annotated[int | None, Field(ge=0, le=1000000000)] = None
    mediaTime: Annotated[float | None, Field(ge=0, le=1e12)] = None
    width: Annotated[int | None, Field(ge=1, le=12000)] = None
    height: Annotated[int | None, Field(ge=1, le=12000)] = None
    regionId: Name | None = None
    roi: Polygon | None = None
    exclusions: list[Polygon] | None = Field(default=None, max_length=32)
    sharpnessStatus: Literal["notAssessed", "assessed"] = "notAssessed"

    @model_validator(mode="after")
    def counts(self):
        if len(self.pixels) != len(self.blockIds) or self.excludedCount > self.pixelCount or len(self.pixels) > self.pixelCount - self.excludedCount:
            raise ValueError("inconsistent_sample_counts")
        return self


Frames = Annotated[list[Frame], Field(min_length=1, max_length=40)]


class Region(StrictModel):
    id: Name
    label: Annotated[str, Field(min_length=1, max_length=256)]
    order: Annotated[int, Field(ge=0, le=4096)]
    mode: Literal["solid", "bands", "patterned"]
    polygon: Polygon
    exclusions: list[Polygon] = Field(max_length=32)
    background: Annotated[str | None, Field(max_length=128)]
    layers: Annotated[int | None, Field(ge=1, le=100)]
    direction: Annotated[str | None, Field(max_length=128)]
    operatorConfirmed: bool
    selectionMethod: Literal["manual", "autoDetected"] = "manual"


class ReferencePatch(StrictModel):
    id: Name
    values: Annotated[list[Annotated[float, Field(ge=-200, le=200)]], Field(min_length=3, max_length=3)]
    split: Literal["train", "holdout"]
    neutral: bool


class ReferenceTarget(StrictModel):
    id: Name
    label: Annotated[str, Field(min_length=1, max_length=256)]
    source: Annotated[str, Field(min_length=1, max_length=512)]
    version: Name
    valueType: Literal["XYZ", "Lab"]
    referenceWhite: Literal["D50", "D65"]
    observer: Literal["2", "10"]
    xyzScale: Literal[1]
    validity: Literal["verified", "unverified"]
    patches: list[ReferencePatch] = Field(min_length=1, max_length=256)
    geometry: dict[str, JsonValue] | None
    health: dict[str, JsonValue] | None

    @model_validator(mode="after")
    def patches_valid(self):
        if len({p.id for p in self.patches}) != len(self.patches):
            raise ValueError("duplicate_patch_id")
        if self.valueType == "XYZ" and any(any(v < 0 or v > 2 for v in p.values) for p in self.patches):
            raise ValueError("xyz_out_of_range")
        if self.valueType == "Lab" and any(not 0 <= p.values[0] <= 100 for p in self.patches):
            raise ValueError("lab_l_out_of_range")
        return self


class Exploratory(StrictModel):
    exploratory: Literal[True]


class CameraObservation(StrictModel):
    patchId: Name
    frames: Frames


class CameraFit(StrictModel):
    observations: list[CameraObservation] = Field(max_length=256)
    fingerprint: Name


class Analyze(StrictModel):
    frames: Frames
    region: Region


class DisplayObservation(StrictModel):
    drive: RGB
    frames: Frames
    witnessFrames: Frames
    cardPatchId: Name | None
    split: Literal["train", "holdout"]
    commandSequence: Annotated[int, Field(ge=1, le=16777215)]
    patchId: Name
    cardFrames: Frames | None = None


class DisplayFit(StrictModel):
    observations: list[DisplayObservation] = Field(min_length=4, max_length=64)
    contaminationBaseline: Frames
    contaminationChecks: list[Frames] = Field(min_length=1, max_length=64)
    layout: Literal["single"]
    fingerprint: Name
    contaminationFabricBaseline: Frames | None = None
    contaminationFabricChecks: list[Frames] | None = Field(default=None, min_length=1, max_length=64)


class MeasurementInput(Analyze):
    sourceColorSpace: Literal["srgb", "display-p3"]
    sourceCaptureIds: list[Name] = Field(min_length=1, max_length=40)
    capturedAt: Annotated[str, Field(min_length=1, max_length=64)]
    cardPatchId: Name | None = None
    cardFrames: Frames | None = None
    witnessFrames: Frames | None = None


class MatchStart(StrictModel):
    measurementId: Name
    maxEvaluations: Annotated[int, Field(ge=1, le=40)] = 40
    target: Annotated[float, Field(gt=0, le=1)] = 0.01
    noiseFloor: Annotated[float, Field(gt=0, le=0.1)] = 0.002


class CameraMatchStart(Analyze):
    sourceColorSpace: Literal["srgb", "display-p3"]
    sourceCaptureIds: list[Name] = Field(min_length=1, max_length=40)
    capturedAt: Annotated[str, Field(min_length=1, max_length=64)]
    maxEvaluations: Annotated[int, Field(ge=1, le=40)] = 40
    target: Annotated[float, Field(gt=0, le=1)] = 0.01
    noiseFloor: Annotated[float, Field(gt=0, le=0.1)] = 0.002


class CameraMatchObserve(StrictModel):
    frames: Frames
    fabricFrames: Frames
    markerSequence: Annotated[int, Field(ge=1, le=16777215)]
    commandSequence: Annotated[int, Field(ge=1, le=16777215)]
    patchId: Name
    stable: bool
    layout: Literal["single"]


class ResponseStart(StrictModel):
    fingerprint: Name
    width: Annotated[int, Field(ge=1, le=12000)]
    height: Annotated[int, Field(ge=1, le=12000)]
    streamId: Annotated[str, Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


class ResponseTarget(ResponseStart):
    frames: Frames
    cardFrames: Frames
    referenceRole: Literal["dark", "middle", "light"] | None = None


class ResponseObserve(ResponseTarget):
    commandSequence: Annotated[int, Field(ge=1, le=16777215)]
    patchId: Name
    phase: Literal["train", "holdout"]


class MatchObserve(StrictModel):
    frames: Frames
    witnessFrames: Frames
    markerSequence: Annotated[int, Field(ge=1, le=16777215)]
    commandSequence: Annotated[int, Field(ge=1, le=16777215)]
    patchId: Name
    stable: bool
    layout: Literal["single", "group"]
    cardPatchId: Name | None = None
    cardFrames: Frames | None = None
    fabricFrames: Frames | None = None


class RegionsInput(StrictModel):
    regions: list[Region] = Field(min_length=1, max_length=32)


class NeutralCardCapture(StrictModel):
    role: Literal["dark", "middle", "light"]
    frames: Frames


class NeutralCheckInput(StrictModel):
    cards: list[NeutralCardCapture] = Field(min_length=3, max_length=3)
    fingerprint: Name


class SuggestInput(StrictModel):
    polygon: Polygon
    orientation: Literal["horizontal", "vertical"]


class CameraProfile(StrictModel):
    id: Name
    status: Literal["referenced", "exploratory"]
    matrix: list[list[Finite]] | None
    fingerprint: Name
    trainingPatchIds: list[Name]
    holdoutPatchIds: list[Name]
    validation: dict[str, JsonValue] | None
    physicallyVerified: bool = False
    referenceId: Name | None = None
    referenceVersion: Name | None = None
    domain: str | None = None
    referenceWhite: str | None = None
    observer: str | None = None
    xyzScale: int | None = None
    cameraDomain: dict[str, JsonValue] | None = None


class DisplayCompensationProfile(StrictModel):
    id: Name
    status: Literal["CameraReferencedDisplayCompensationProfile"]
    fingerprint: Name
    cameraReferenced: bool
    absoluteCalibration: Literal[False] = False
    iccProfile: Literal[False] = False
    physicalAccuracyVerified: Literal[False] = False
    validation: dict[str, JsonValue]
    domain: str
    model: str
    matrix: list[list[Finite]]
    offset: list[Finite]
    trainingPatchIds: list[Name]
    holdoutPatchIds: list[Name]
    contaminationStatus: Literal["neutralAndFabricPassed"]


class Capture(StrictModel):
    captureId: Name
    width: Annotated[int, Field(ge=1, le=12000)]
    height: Annotated[int, Field(ge=1, le=12000)]
    sourceColorSpace: Literal["srgb", "display-p3"]
    colorProvenance: dict[str, JsonValue]
    previewUrl: str


class Measurement(StrictModel):
    id: Name
    region: Region
    captureQuality: Literal["accepted", "rejected"]
    quality: dict[str, JsonValue]
    linearRgb: list[Finite] | None
    sourceColorSpace: Literal["srgb", "display-p3"]
    sourceCaptureIds: list[Name]
    capturedAt: str
    profileVersion: int
    catalogStatus: Literal["referenced", "exploratory", "rejected", "manualOverride"]
    displayStatus: str
    catalogColor: dict[str, JsonValue] | None
    approved: bool
    provenance: Literal["referencedLive", "approximateReplay", "exploratoryLive"]
    instrumentDeltaE00: None = None
    displayDriveRgb: RGB | None = None
    catalogHexSrgb: str | None = None
    independentValidationStatus: Literal["notTested"] = "notTested"
    physicalControlStatus: Literal["unverified"] = "unverified"
    approvalLimitations: list[str]
    sourceFrameProvenance: list[dict[str, JsonValue]]
    sourceMeasurementId: Name | None = None
    manualOverride: bool = False
    originalEstimate: dict[str, JsonValue] | None = None
    overrideReason: str | None = None
    version: int = 1
    displayMatch: dict[str, JsonValue] | None = None
    captureConditions: dict[str, JsonValue]


class MatchRun(StrictModel):
    runId: Name
    measurementId: Name | None = None
    nextDrive: RGB | None
    bestDrive: RGB | None = None
    objectiveValue: Finite | None = None
    iterations: Annotated[int, Field(ge=0, le=40)] = 0
    status: str
    terminationReason: str | None = None
    patchId: Name | None = None
    commandSequence: int | None = None


class ValidationReport(StrictModel):
    id: Name
    type: Literal["repeatability", "independentReacquisition", "instrumentComparison"]
    independentValidationStatus: Literal["notTested", "operatorSupplied"]
    independentInstrumentValidation: Literal[False] = False
    physicalEvidenceVerifiedBySoftware: Literal[False]
    limitations: list[str] = Field(default_factory=list)
    independentPlacements: int | None = None
    domain: dict[str, JsonValue] | None = None
    method: str | None = None
    centerLab: list[Finite] | None = None
    statistics: dict[str, Finite] | None = None
    perCapture: list[dict[str, JsonValue]] | None = None
    captureId: Name | None = None
    referenceKind: str | None = None
    perPatch: list[dict[str, JsonValue]] | None = None
    measurementId: Name | None = None
    instrumentDeltaE00: Finite | None = None
    conditions: dict[str, JsonValue] | None = None
    estimate: dict[str, JsonValue] | None = None
    instrumentReading: dict[str, JsonValue] | None = None
    warning: str | None = None


class RepeatabilitySample(StrictModel):
    captureId: Name
    placementId: Name
    lab: Annotated[list[Annotated[float, Field(ge=-200, le=200)]], Field(min_length=3, max_length=3)]


class RepeatabilityInput(StrictModel):
    type: Literal["repeatability"]
    referenceWhite: Literal["D50", "D65"]
    observer: Literal["2"]
    samples: list[RepeatabilitySample] = Field(min_length=10, max_length=256)


class ReacquisitionInput(StrictModel):
    type: Literal["reacquisition"]
    referenceWhite: Literal["D50", "D65"]
    observer: Literal["2"]
    captureId: Name
    original: dict[str, list[Finite]] = Field(min_length=1, max_length=256)
    observed: dict[str, list[Finite]] = Field(min_length=1, max_length=256)


class InstrumentInput(StrictModel):
    type: Literal["instrument"]
    measurementId: Name
    estimate: dict[str, JsonValue] = Field(max_length=32)
    reading: dict[str, JsonValue] = Field(max_length=32)


class OverrideInput(StrictModel):
    catalogHexSrgb: Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]
    reason: Annotated[str, Field(min_length=1, max_length=512)]


class Session(StrictModel):
    sessionId: Name
    mode: Literal["threeStage", "catalogOnly", "replay", "cameraMatch"]
    state: Literal["reference", "camera", "display", "fabric"]
    profileVersion: int
    capabilities: dict[str, JsonValue]
    conditions: dict[str, JsonValue]
    references: ReferenceTarget | Exploratory | None
    cameraProfile: dict[str, JsonValue] | None
    displayProfile: dict[str, JsonValue] | None
    measurements: list[Measurement]
    currentPatch: dict[str, JsonValue] | None
    paused: bool
    pauseReason: str | None
    captures: list[dict[str, JsonValue]]
    validationReports: list[dict[str, JsonValue]]
    neutralCheck: dict[str, JsonValue] | None = None
    responseProfile: dict[str, JsonValue] | None = None
    diagnosticId: Name
    diagnosticsEnabled: bool


DeviceCapabilityReport = Capabilities
SampleRegion = Region
