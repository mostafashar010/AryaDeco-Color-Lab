import { useEffect, useRef, useState } from 'react';
import { Api, type Credentials, type LivePreviewInput, type Mode, type Patch, type Snapshot } from './session';
import { Camera, CapturePipeline, verifyCanvas } from './camera';
import { RegionEditor } from './RegionEditor';
import { bounds, type Frame, type Region } from './sampling';
import { decodeMarker, type Rect } from './marker';
import { awaitWithSignal, measurementPayload, groupCapacity, referenceCaptureKey, normalizedRegion, parseReference, runGrid, runMatch, runCameraMatch, waitForPatch, type Reference, type ReferenceMeta } from './workflow';
import { fabricRegions, nextLiveRequirement, runLiveAutomation, runCameraMatchQueue, type LiveContext, type LiveItem } from './liveAutomation';
import { suggestLiveRegions as defaultSuggestLiveRegions } from './liveBands';
import { guidedSceneAction, scanLiveScene, scanLiveNeutralCards, sceneRegions, suppliedReferenceRegions } from './automaticScene';
import type { LiveScene } from './liveScene';
import { runNeutralGuide } from './neutralGuide';
import { diagnosticTrace, diagnosticErrorCode, sanitizeEvidenceSnapshot, type EvidenceSnapshot, type TraceLog } from './trace';
import { LiveTracker, type LiveTracking, type TrackingPhase } from './liveTracking';
import { DiagnosticSync, sendDiagnosticBatch } from './diagnosticSync';
import { runResponseGuide, type ResponseGeometry, type ResponseCommand } from './responseGuide';
import {LiveDebugPanel,captureDebugFrame} from './LiveDebugPanel';
import {DiagnosticEvidencePanel} from './DiagnosticEvidencePanel';

function observedEvidence(value:LiveTracking,patch:Patch|null):EvidenceSnapshot|undefined{
  const samples=value;
  const targets=value.previewBands??[],feedback=value.previewFeedback;
  const pin=Boolean(patch?.rendered&&patch.layout==='liveBands'&&patch.commandSequence===value.evidence.markerSequence&&patch.bands?.length===targets.length&&targets.every((band,index)=>band.id===patch.bands![index].id&&band.top===patch.bands![index].top&&band.bottom===patch.bands![index].bottom));
  const reasons:string[]=[...(samples.previewFeedbackRejectionReasons??[])];
  const relative=value.relativeGeometryStable&&value.frame.timeSource==='callbackClock'&&value.frame.reportedMediaTime===0;
  if(value.fresh===false&&!relative)reasons.push('geometryUnstable');
  if(feedback){try{if(feedback.markerSequence!==value.evidence.markerSequence||decodeMarker(feedback.markerPixels)!==value.evidence.markerSequence)reasons.push('markerMismatch');}catch{reasons.push('markerMismatch');}}
  if(feedback&&(feedback.screenAppearanceBands.length!==targets.length||feedback.screenAppearanceBands.some((band,index)=>band.id!==targets[index]?.id)))reasons.push('bandLayoutMismatch');
  for(const sample of samples.previewSamplingEvidence??[])reasons.push(...sample.reasons);
  if(value.evidence.markerSequence===undefined)reasons.push('markerMissing');
  else if(patch&&value.evidence.markerSequence!==patch.commandSequence)reasons.push('markerMismatch');
  if(!patch?.rendered)reasons.push('commandNotRendered');
  if(value.moving||value.pixelMoving||value.surfaceChanged)reasons.push('cameraMoving');
  if(!value.geometryStable&&!relative)reasons.push('geometryUnstable');
  if(patch?.layout==='liveBands'&&!pin)reasons.push('bandLayoutMismatch');
  if(!feedback&&!reasons.length)reasons.push('screenApertureMissing');
  const normalize=(polygon:[number,number][])=>polygon.map(([x,y])=>[x/value.frame.width,y/value.frame.height]);
  const bands=targets.slice(0,32).map((target,bandIndex)=>{
    const measured=samples.previewSamplingEvidence?.find(sample=>sample.id===target.id),accepted=feedback?.screenAppearanceBands.find(band=>band.id===target.id),region=value.regions.find(region=>region.id===target.id);
    return{bandIndex,top:target.top,bottom:target.bottom,targetRgb:target.previewRgb,...(pin?{driveRgb:patch!.bands![bandIndex].drive}:{}),...(measured?.rgb?{observedRgb:measured.rgb}:accepted?{observedRgb:accepted.rgb}:{}),...(region?{roi:normalize(region.polygon)}:{}),...(measured?{quality:{status:measured.reasons.length?'rejected':'accepted',validPixels:measured.validPixels,validBlocks:measured.validBlocks,blockSpread:measured.blockSpread,clippedRate:measured.clippedRate,shadowClippedRate:measured.shadowClippedRate,highlightClippedRate:measured.highlightClippedRate},reasons:measured.reasons}:accepted?{quality:{status:'accepted',validPixels:accepted.validPixels,validBlocks:accepted.validBlocks,blockSpread:accepted.blockSpread,clippedRate:accepted.clippedRate}}:{quality:{status:'notAssessed'}})};
  });
  const marker=value.marker;
  return sanitizeEvidenceSnapshot({role:'camera',stage:pin&&feedback&&!reasons.length?'sampled':'rejected',commandSequence:patch?.commandSequence,observedCommandSequence:pin?patch?.commandSequence:undefined,markerSequence:value.evidence.markerSequence,presentedFrames:value.frame.presentedFrames,rawMediaTime:value.frame.reportedMediaTime??value.frame.mediaTime,nativeWidth:value.frame.width,nativeHeight:value.frame.height,analysisWidth:value.debug?.analysisWidth,analysisHeight:value.debug?.analysisHeight,colorSpace:'srgb',rgbEncoding:'encoded',physicalAccuracyVerified:false,mapping:value.previewMapping,screenRoi:value.previewScreenRoi??feedback?.screenRoi,markerRoi:marker?normalize([[marker.x,marker.y],[marker.x+marker.width,marker.y],[marker.x+marker.width,marker.y+marker.height],[marker.x,marker.y+marker.height]]):undefined,markerCells:value.previewMarkerCells??feedback?.markerPixels,bands,rejectionReasons:[...new Set(reasons)]});
}

export class LivePreviewPump {
  private latest: LivePreviewInput | null = null;
  private queuedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private stopped = false;
  private nextAt = -Infinity;
  private presented = -1;
  private mediaTime = -1;
  private lastDetectionAt = -Infinity;
  private lastHeartbeatAt = -Infinity;
  private lastSuccessful: LivePreviewInput | null = null;
  private lastSuccessfulAt = -Infinity;
  private latestHeartbeat = false;
  constructor(private post: (body: LivePreviewInput) => Promise<Patch>, private received: (patch: Patch) => void, private failed: (error: unknown) => void, private prepare: (body: LivePreviewInput) => LivePreviewInput = body => body) {}
  update(body: LivePreviewInput) {
    if (this.stopped || body.sourceFrame.presentedFrames <= this.presented || body.sourceFrame.mediaTime < this.mediaTime) return;
    this.lastDetectionAt = performance.now();
    if (!body.bands.length) {
      this.presented = body.sourceFrame.presentedFrames; this.mediaTime = body.sourceFrame.mediaTime; this.latest = null;
      return;
    }
    this.queue(body);
  }
  heartbeat(sourceFrame: LivePreviewInput['sourceFrame'], streamId: string) {
    const now = performance.now();
    const needsRescue = this.lastSuccessfulAt !== -Infinity && now - this.lastSuccessfulAt >= 3000;
    if (this.stopped || (!needsRescue && now - this.lastDetectionAt < 2000) || now - this.lastHeartbeatAt < 1000 || sourceFrame.presentedFrames <= this.presented || sourceFrame.mediaTime < this.mediaTime) return;
    this.lastHeartbeatAt = now;
    // A fresh camera callback keeps only the locator alive, never an old color estimate.
    this.queue({ streamId, sourceFrame, bands: [{ id: 'locator', drive: [0.5, 0.5, 0.5], top: 0, bottom: 1 }], mapping: 'orderedPreview', warnings: ['orderedPreview', 'screenAlignmentUncertain', 'cameraControlsUnknown', 'uncalibratedPreview'] }, true);
  }
  private queue(body: LivePreviewInput, heartbeat = false) {
    this.presented = body.sourceFrame.presentedFrames; this.mediaTime = body.sourceFrame.mediaTime;
    this.latest = body; this.latestHeartbeat = heartbeat; this.queuedAt = performance.now(); this.flush();
  }
  stop() { this.stopped = true; this.latest = null; if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private flush() {
    if (this.stopped || this.pending || !this.latest || this.timer !== null) return;
    if (performance.now() - this.queuedAt >= 2500) { this.latest = null; return; }
    const candidate = this.prepare(this.latest); this.latest = candidate;
    const previous = this.lastSuccessful;
    // Hold the marker for camera latency; only new observations may refresh after this bound.
    if (!this.latestHeartbeat && !candidate.feedback && previous && performance.now() - this.lastSuccessfulAt < 1500 && candidate.streamId === previous.streamId && candidate.mapping === previous.mapping && candidate.bands.length === previous.bands.length && candidate.bands.every((band, index) => {
      const old = previous.bands[index];
      return band.id === old.id && band.top === old.top && band.bottom === old.bottom && band.drive.every((channel, axis) => channel === old.drive[axis]);
    })) { this.latest = null; return; }
    const delay = this.nextAt - performance.now();
    if (delay > 0) { this.timer = setTimeout(() => { this.timer = null; this.flush(); }, delay); return; }
    const body = this.latest; this.latest = null; this.pending = true;
    void this.post(body).then(patch => {
      this.lastSuccessful = body; this.lastSuccessfulAt = performance.now();
      this.nextAt = performance.now() + 500;
      if (!this.stopped) this.received(patch);
    }).catch(error => {
      if (this.stopped) return;
      const rate = error as { status?: unknown; code?: unknown; retryAfterMs?: unknown } | null;
      if (rate?.status === 409 && rate.code === 'preview_rate_limit' && typeof rate.retryAfterMs === 'number' && Number.isFinite(rate.retryAfterMs) && rate.retryAfterMs >= 0) {
        // The rejected image is gone; only a newer actual frame may be sent next.
        this.nextAt = performance.now() + Math.max(500, rate.retryAfterMs);
      } else if (rate?.status === 409 && (rate.code === 'preview_feedback_stale_command' || rate.code === 'preview_feedback_context_changed' || rate.code === 'preview_feedback_expired')) {
        // Drop even the in-flight backlog: correction needs a capture after this conflict.
        this.latest = null; this.nextAt = performance.now() + 500;
      } else { this.stop(); this.failed(error); }
    }).finally(() => { this.pending = false; this.flush(); });
  }
}

type Props = { credentials: Credentials; snapshot: Snapshot; mode: Mode; api: Api; send: (event: string, payload: unknown) => boolean; getPatch: () => Patch | null; pause: (reason: string) => void; refresh: () => Promise<void> | void; registerAbort: (controller: AbortController) => void; onDeleted?: () => void; onChoosePreview?: () => void; suggestLiveRegions?: (video: HTMLVideoElement, region: Region) => Promise<Region[]>; scanScene?: typeof scanLiveScene; scanCards?: typeof scanLiveNeutralCards; trace?: TraceLog };
export function Workbench({ credentials, snapshot, mode, api, send, getPatch, pause, refresh, registerAbort, onDeleted, onChoosePreview, suggestLiveRegions = defaultSuggestLiveRegions, scanScene = scanLiveScene, scanCards = scanLiveNeutralCards, trace = diagnosticTrace }: Props) {
  const traceSessionBoundary=useRef({sessionId:credentials.sessionId,trace,sequence:trace.entries().at(-1)?.sequence??0});
  if(traceSessionBoundary.current.sessionId!==credentials.sessionId||traceSessionBoundary.current.trace!==trace)traceSessionBoundary.current={sessionId:credentials.sessionId,trace,sequence:trace.entries().at(-1)?.sequence??0};
  const [traceRows, setTraceRows] = useState(() => trace.entries());
  useEffect(() => { setTraceRows(trace.entries()); return trace.subscribe(() => setTraceRows(trace.entries())); }, [trace]);
  const [diagnostics, setDiagnostics] = useState<ReturnType<DiagnosticSync['status']>>({ state: 'idle', savedSequence: 0 });
  const [remoteEvidence,setRemoteEvidence]=useState<EvidenceSnapshot[]>([]);
  useEffect(() => {
    if(snapshot.diagnosticsEnabled===false)return;
    const firstSequence=trace.entries().at(-1)?.sequence??0;
    const sync = new DiagnosticSync(trace, body => {
      const events=body.events.filter(row=>row.sequence>firstSequence);
      return events.length?sendDiagnosticBatch(credentials.sessionId, credentials.token,{events}):Promise.resolve({accepted:0});
    });
    const unsubscribe = sync.subscribe(() => setDiagnostics(sync.status())); sync.start();
    return () => { unsubscribe(); sync.stop(); };
  }, [credentials.sessionId, credentials.token, trace, snapshot.diagnosticsEnabled]);
  useEffect(()=>{
    setRemoteEvidence([]);if(snapshot.diagnosticsEnabled!==true)return;
    const abort=new AbortController();let pending=false;
    const timer=setInterval(()=>{if(pending||document.hidden)return;pending=true;
      void fetch(`/api/sessions/${encodeURIComponent(credentials.sessionId)}/diagnostics/summary`,{headers:{Authorization:`Bearer ${credentials.token}`},signal:abort.signal,cache:'no-store',referrerPolicy:'no-referrer'}).then(async response=>{
        if(!response.ok)return;const result=await response.json(),latest=result.latestEvidence;
        if(!latest||typeof latest!=='object')return;
        const evidence:EvidenceSnapshot[]=[];
        for(const role of ['camera','display','server'])for(const stage of ['intended','rendered','decoded','sampled','feedbackAccepted','rejected']){const safe=sanitizeEvidenceSnapshot(latest[role]?.[stage]);if(safe)evidence.push(safe);}
        if(!abort.signal.aborted)setRemoteEvidence(evidence);
      }).catch(()=>{}).finally(()=>{pending=false;});
    },3000);
    return()=>{clearInterval(timer);abort.abort();};
  },[credentials.sessionId,credentials.token,snapshot.diagnosticsEnabled]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState('آماده'); const [result, setResult] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { trace.add('workbench', 'stage', { progress }); }, [progress, trace]);
  const [regions, setRegions] = useState<Region[]>([]); const [marker, setMarker] = useState<Rect | null>(null); const [dimensions, setDimensions] = useState({ width: 640, height: 480 });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]); const [deviceId, setDeviceId] = useState(''); const [cameraReport, setCameraReport] = useState<Record<string, unknown> | null>(null); const [cameraActive, setCameraActive] = useState(false); const [colorSpace, setColorSpace] = useState<'srgb' | 'display-p3'>('srgb');
  const [controlJson, setControlJson] = useState(''); const [conditionsJson, setConditionsJson] = useState('');
  const [reference, setReference] = useState<Reference | null>(null); const [exploratory, setExploratory] = useState(false); const [referenceText, setReferenceText] = useState('');
  const [meta, setMeta] = useState<ReferenceMeta>({ id: '', label: '', source: '', version: '', valueType: 'Lab', referenceWhite: 'D50', observer: '2', validity: 'unverified' });
  const [manual, setManual] = useState({ id: '', a: '', b: '', c: '', split: 'train', neutral: false });
  const [observations, setObservations] = useState<{ patchId: string; frames: Frame[] }[]>([]); const [bindings, setBindings] = useState<Record<string, string>>({}); const [displayRoi, setDisplayRoi] = useState(''); const [witnessRoi, setWitnessRoi] = useState(''); const [fabricRoi, setFabricRoi] = useState(''); const [cardRoi, setCardRoi] = useState(''); const [cardPatchId, setCardPatchId] = useState('');
  const [consent, setConsent] = useState(false); const [retention, setRetention] = useState(false); const [image, setImage] = useState<{ captureId: string; width: number; height: number; sourceColorSpace: string; previewUrl: string } | null>(null); const [preview, setPreview] = useState('');
  const [measurements, setMeasurements] = useState<Record<string, unknown>[]>([]); const [matchId, setMatchId] = useState(''); const [matches, setMatches] = useState<Record<string, unknown>[]>([]); const [exportKind, setExportKind] = useState<'experimental' | 'approved'>('experimental'); const [validationText, setValidationText] = useState(''); const [tableCopy, setTableCopy] = useState('');
  const [overrideId, setOverrideId] = useState(''); const [overrideHex, setOverrideHex] = useState(''); const [overrideReason, setOverrideReason] = useState('');
  const [groupPage, setGroupPage] = useState(0);
  const [capturedReferenceKey, setCapturedReferenceKey] = useState('');
  const [advanced, setAdvanced] = useState(mode === 'replay'); const [alignmentChecked, setAlignmentChecked] = useState(false); const [queue, setQueue] = useState<LiveItem[]>([]);
  const [drawRole, setDrawRole] = useState('fabric'); const [suggestedIds, setSuggestedIds] = useState<string[]>([]);
  const [scene, setScene] = useState<LiveScene | null>(null);
  const [neutralDone, setNeutralDone] = useState(false); const [neutralReport, setNeutralReport] = useState<Record<string, unknown> | null>(null);
  const [measurementStarted, setMeasurementStarted] = useState(false);
  const [tracking, setTracking] = useState<LiveTracking | null>(null);
  const [trackingClock, setTrackingClock] = useState(() => performance.now());
  const lastObservation = useRef<{ value: LiveTracking; receivedAt: number } | null>(null);
  const lastTrackingReceipt = useRef<number | null>(null); const completedReceipts = useRef(0);
  const cameraHeartbeat = useRef({ callbacks: 0, lastAt: 0 });
  const [livePreview, setLivePreview] = useState(false); const [previewStatus, setPreviewStatus] = useState('پیش‌نمایش کالیته شروع نشده');
  const [previewCompensation, setPreviewCompensation] = useState<Patch['compensation']>();
  const [responseStatus, setResponseStatus] = useState('پاسخ نمایشگر اندازه‌گیری نشده؛ پیش‌نمایش خام است.');
  const [responseBusy, setResponseBusy] = useState(false);
  const [manualResponseSetup, setManualResponseSetup] = useState(false); const [manualResponseConfirmed, setManualResponseConfirmed] = useState(false);
  const manualResponseRunning = useRef(false);
  const responseRunning = useRef(false); const responseGeometry = useRef<ResponseGeometry | null>(null);
  const previewPump = useRef<LivePreviewPump | null>(null); const previewAbort = useRef<AbortController | null>(null); const previewStarting = useRef(false); const previewStream = useRef('');
  const previewPausePending = useRef(false);
  const previewApi = useRef(api); previewApi.current = api;
  const patchGetter = useRef(getPatch); patchGetter.current = getPatch;
  const trackerRef = useRef<LiveTracker | null>(null); const trackingRef = useRef<LiveTracking | null>(null);
  const previewDisplayKey = useRef('');
  const trackingPhase = useRef<TrackingPhase>(mode === 'cameraMatch' || mode === 'threeStage' ? 'cards' : 'scene');
  const trackingSequence = useRef<number | undefined>(undefined); const commandGraceUntil = useRef(0);
  const trackingPurpose=useRef<'response'|undefined>(undefined);
  const lastTrackingTrace = useRef(''); const lastTrackingTraceAt = useRef(0); const movedPause = useRef(false);
  const trackingUpdate = useRef<(value: LiveTracking) => void>(() => {});
  const neutralDoneRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null); const cameraRef = useRef<Camera | null>(null); const pipelineRef = useRef<CapturePipeline | null>(null); const activeAbort = useRef<AbortController | null>(null);
  const serverRef = useRef(snapshot); const propSnapshotRef = useRef(snapshot); const waitingResume = useRef(false); const busyRef = useRef(false); const editorRef = useRef<HTMLDivElement | null>(null);
  const colorSpaceRef = useRef(colorSpace); colorSpaceRef.current = colorSpace;
  if (propSnapshotRef.current !== snapshot) { propSnapshotRef.current = snapshot; serverRef.current = snapshot; }
  const liveRef = useRef<LiveContext>({ mode, snapshot, cameraReady: cameraActive, reference, regions, bindings, roles: { display: displayRoi, witness: witnessRoi, card: cardRoi, fabric: fabricRoi }, marker, cardPatchId, width: dimensions.width, height: dimensions.height });
  const actualReference = (snapshot.references as Reference | undefined)?.patches ? snapshot.references as Reference : snapshot.references === undefined ? reference : null;
  liveRef.current = { mode, snapshot: serverRef.current, cameraReady: cameraActive, reference: actualReference, regions, bindings, roles: { display: displayRoi, witness: witnessRoi, card: cardRoi, fabric: fabricRoi }, marker, cardPatchId, width: dimensions.width, height: dimensions.height };
  const getContext = () => ({ ...liveRef.current, snapshot: serverRef.current });
  useEffect(() => {
    if (!cameraActive) return;
    let tracedAt = performance.now();
    const timer = setInterval(() => {
      const now = performance.now(); setTrackingClock(now);
      if (document.hidden || now - tracedAt < 3000) return;
      tracedAt = now;
      const value = trackingRef.current;
      trace.add('tracking', 'heartbeat', { phase: trackingPhase.current, status: value?.status ?? 'waiting', fresh: Boolean(value && value.fresh !== false && lastTrackingReceipt.current !== null && now - lastTrackingReceipt.current < 2500), frameCallbacks: Math.max(cameraHeartbeat.current.callbacks, value?.debug?.frameCallbacks ?? 0), jobsStarted: value?.debug?.jobsStarted ?? 0, jobsCompleted: value?.debug?.jobsCompleted ?? completedReceipts.current, lastReceiptAgeMs: lastTrackingReceipt.current === null ? undefined : now - lastTrackingReceipt.current, reason: value?.debug?.reason });
    }, 500);
    return () => clearInterval(timer);
  }, [cameraActive, trace]);
  useEffect(() => { if (snapshot.measurements) setMeasurements(snapshot.measurements); }, [snapshot.measurements]);
  useEffect(() => { if ((snapshot.references as Reference | undefined)?.patches) setReference(snapshot.references as Reference); }, [snapshot.references]);
  useEffect(() => {
    const previewStopAcknowledged = previewPausePending.current && snapshot.pauseReason === 'operator_pause' && !snapshot.currentPatch;
    if (snapshot.paused && !previewStopAcknowledged && (!waitingResume.current || ['device_disconnected', 'socket_disconnected', 'page_hidden', 'operator_pause'].includes(snapshot.pauseReason ?? ''))) { activeAbort.current?.abort(); setAlignmentChecked(false);setManualResponseConfirmed(false); }
  }, [snapshot]);
  useEffect(() => { if (snapshot.paused && (!previewStarting.current || ['device_disconnected', 'socket_disconnected', 'page_hidden', 'operator_pause'].includes(snapshot.pauseReason ?? ''))) stopLivePreview(false); }, [snapshot]);
  useEffect(() => {
    const stop = () => { stopLivePreview(false); activeAbort.current?.abort(); setAlignmentChecked(false);setManualResponseConfirmed(false); trackerRef.current?.stop(); cameraRef.current?.stop(); pipelineRef.current?.stop();pipelineRef.current=null; setCameraActive(false); trackingRef.current = null; setTracking(null); neutralDoneRef.current = false; setNeutralDone(false); setNeutralReport(null); clearGeometry(); liveRef.current = { ...liveRef.current, cameraReady: false }; if (videoRef.current) videoRef.current.srcObject = null; };
    const hidden = () => { if (document.visibilityState !== 'visible') stop(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', stop);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', stop); };
  }, []);
  useEffect(() => () => { previewAbort.current?.abort(); previewPump.current?.stop(); activeAbort.current?.abort(); trackerRef.current?.stop(); cameraRef.current?.stop(); pipelineRef.current?.stop(); }, []);
  useEffect(() => () => { previewAbort.current?.abort(); previewPump.current?.stop(); }, [credentials.sessionId, mode]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const action = async (work: () => Promise<unknown>, shouldRefresh = true) => {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(''); setProgress('در حال اجرا');
    trace.add('workbench', 'operation_start', { mode });
    try { await work(); if (shouldRefresh) await refresh(); setProgress('عملیات پاسخ گرفت؛ اعتبار فقط طبق کیفیت سرور'); trace.add('workbench', 'operation_complete'); }
    catch (e) { setError(movedPause.current ? 'قاب حرکت کرد یا ناحیه گم شد؛ برداشت لغو شد. پس از سه تشخیص پایدار، شرایط را دوباره تأیید کنید و شروع را بزنید.' : e instanceof Error ? e.message : 'خطای عملیات'); setProgress('متوقف / ناموفق'); trace.add('workbench', 'operation_error', { name: e instanceof Error ? e.name : 'Error',code:diagnosticErrorCode(e),phase:trackingPhase.current }); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const controller = (register = true) => { activeAbort.current?.abort(); const abort = new AbortController(); activeAbort.current = abort; if (register) registerAbort(abort); return abort; };
  const capture = async (selected: Region[], signal: AbortSignal, expectedSequence?: number) => {
    if (!advanced && mode !== 'replay') await waitForStable(signal, expectedSequence);
    const current = getContext();
    if (signal.aborted || current.snapshot.paused) throw new Error('جلسه متوقف است؛ ابتدا شاهد را بررسی و ادامه را تأیید کنید.');
    if (!cameraRef.current || !videoRef.current || !current.cameraReady) throw new Error('دوربین واقعی را ابتدا فعال کنید.');
    if (activeAbort.current?.signal === signal) registerAbort(activeAbort.current);
    if (expectedSequence !== undefined && !current.marker) throw new Error('ROI نشانگر فیزیکی انتخاب نشده است.');
    if (selected.some(r => !r.operatorConfirmed && r.selectionMethod !== 'autoDetected')) throw new Error('هندسهٔ ناحیه هنوز شناسایی نشده است.');
    if (!pipelineRef.current) pipelineRef.current = new CapturePipeline();
    verifyCanvas(document.createElement('canvas'), colorSpaceRef.current);
    const fingerprint = cameraRef.current.fingerprint();
    const data = await awaitWithSignal(signal, () => pipelineRef.current!.capture(videoRef.current!, selected, cameraRef.current!, signal, current.marker ?? undefined, expectedSequence, colorSpaceRef.current));
    trace.add('capture', 'batch_complete', { regionCount: selected.length, frameCounts: data.map(rows => rows.length), presentedFrames: data[0]?.at(-1)?.presentedFrames, mediaTime: data[0]?.at(-1)?.mediaTime, width: videoRef.current.videoWidth, height: videoRef.current.videoHeight, commandSequence: expectedSequence });
    if (fingerprint !== cameraRef.current.fingerprint()) { pause('camera_settings_changed'); throw new Error('تنظیمات تغییر کرد؛ برداشت کنار گذاشته شد.'); }
    setCameraReport({ ...cameraRef.current.report(), canvasColorSpace: colorSpace });
    return data;
  };
  const regionById = (id: string, label: string) => { const r = liveRef.current.regions.find(r => r.id === id); if (!r) throw new Error(`ناحیهٔ ${label} انتخاب نشده است.`); return r; };
  const requestPatch = async (drive: [number, number, number], id: string, sequence?: number) => {
    if (serverRef.current.paused) throw new Error('جلسه متوقف است.');
    const abort = activeAbort.current ?? controller();
    const previous = patchGetter.current()?.commandSequence ?? 0;
    if (abort.signal.aborted) throw new Error('جلسه متوقف شد.');
    configureTracking('scene', sequence || previous + 1);
    if (!sequence && !send('display.patch.set', { profileVersion: serverRef.current.profileVersion, patchId: id, displayDriveRgb: drive, layout: 'single', sampleIds: [] })) throw new Error('نمایشگر متصل نیست.');
    const patch = await waitForPatch(() => patchGetter.current(), id, sequence || previous + 1, abort.signal);
    return { patchId: patch.patchId, commandSequence: patch.commandSequence };
  };
  const loopCapture = async (command?: { patchId: string; commandSequence: number }, fabric?: Region, signal = activeAbort.current!.signal) => {
    if (!command) throw new Error('فرمان نمایشگر موجود نیست.');
    const patch = getPatch();
    configureTracking('scene', command.commandSequence);
    if (!patch || patch.patchId !== command.patchId || patch.commandSequence !== command.commandSequence || !patch.rendered) throw new Error('فرمان نمایشگر عوض شد یا رندر تأیید نشده است.');
    const roles = liveRef.current.roles;
    const selected = [regionById(roles.display, 'رنگ نمایشگر')];
    if (liveRef.current.mode !== 'cameraMatch') selected.push(regionById(roles.witness, 'شاهد خنثی'));
    if (roles.card) selected.push(regionById(roles.card, 'کارت مرجع'));
    if (fabric || roles.fabric) selected.push(fabric ?? regionById(roles.fabric, 'پارچه برای آلودگی نور'));
    if (new Set(selected.map(r => r.id)).size !== selected.length) throw new Error('ناحیه‌های رنگ، شاهد، کارت و پارچه باید متفاوت باشند.');
    const frames = await capture(selected, signal, command.commandSequence);
    if (getPatch()?.commandSequence !== command.commandSequence) throw new Error('فرمان در حین برداشت تغییر کرد.');
    return frames;
  };
  const readServer = async () => { const signal = activeAbort.current?.signal; const state = signal ? await awaitWithSignal(signal, () => api.get()) : await api.get(); serverRef.current = state; if (state.measurements) setMeasurements(state.measurements); return state; };
  const stopAutomation = (reason = 'operator_pause') => { activeAbort.current?.abort(); if (responseRunning.current) setResponseStatus('اندازه‌گیری لغو شد؛ پروفایل ناقص فعال نیست.'); setAlignmentChecked(false); neutralDoneRef.current = false; setNeutralDone(false); pause(reason); trace.add('workbench', 'measurement_stopped', { reason }); };
  const stopLivePreview = (notify = true) => {
    const running = previewPump.current !== null || previewStarting.current;
    previewAbort.current?.abort(); previewPump.current?.stop(); previewPump.current = null; previewStarting.current = false; setLivePreview(false);
    setPreviewCompensation(undefined);
    previewDisplayKey.current = ''; trackerRef.current?.configure({ displayBands: undefined });
    if (running) { setAlignmentChecked(false); setPreviewStatus('نمایش زنده متوقف شد؛ رنگ قبلی روی A فقط موقت می‌ماند.'); if (notify) { previewPausePending.current = true; pause('operator_pause'); } }
  };
  const waitForPreviewPause = async (signal: AbortSignal) => {
    if (!previewPausePending.current) return;
    const deadline = performance.now() + 12000;
    do {
      const state = await awaitWithSignal(signal, () => previewApi.current.get()); serverRef.current = state;
      if (state.paused && !state.currentPatch) { previewPausePending.current = false; return; }
      await awaitWithSignal(signal, () => new Promise<void>(resolve => setTimeout(resolve, 80)));
    } while (performance.now() < deadline);
    throw new Error('توقف نمایش زنده هنوز از سرور تأیید نشده؛ اتصال دو گوشی را بررسی و دوباره شروع کنید.');
  };
  const startLivePreview = async () => {
    if (mode !== 'cameraMatch' || !cameraActive || !videoRef.current || previewStarting.current || previewPump.current || busyRef.current) return;
    activeAbort.current?.abort(); previewStarting.current = true; setError(''); setLivePreview(true); setPreviewStatus('در حال پیدا کردن نوارها');
    const abort = new AbortController(); previewAbort.current = abort;
    try {
      await waitForPreviewPause(abort.signal);
      let state = await awaitWithSignal(abort.signal, () => previewApi.current.get()); serverRef.current = state;
      if (!(state.capabilities as { display?: unknown } | undefined)?.display) throw new Error('گوشی A را با QR وصل کنید و صفحهٔ آن را باز نگه دارید.');
      if (state.paused) {
        if (!send('session.resume', { witnessChecked: true })) throw new Error('اتصال جلسه برقرار نیست.');
        const deadline = performance.now() + 12000;
        do {
          state = await awaitWithSignal(abort.signal, () => previewApi.current.get()); serverRef.current = state;
          if (!state.paused) break;
          await awaitWithSignal(abort.signal, () => new Promise<void>(resolve => setTimeout(resolve, 80)));
        } while (performance.now() < deadline);
        if (state.paused) throw new Error('سرور ادامهٔ جلسه را تأیید نکرد؛ اتصال دو گوشی را بررسی کنید.');
      }
      registerAbort(abort); clearGeometry(); configureTracking('scene'); trackerRef.current?.resetBaseline();
      const video = videoRef.current;
      if (!video.requestVideoFrameCallback) throw new Error('این مرورگر دریافت فریم تازه برای پیش‌نمایش را پشتیبانی نمی‌کند.');
      const sourceFrame = await awaitWithSignal(abort.signal, () => new Promise<LivePreviewInput['sourceFrame']>((resolve, reject) => {
        const cancel = () => { video.cancelVideoFrameCallback(handle); clearTimeout(timeout); abort.signal.removeEventListener('abort', cancel); };
        const timeout = setTimeout(() => { cancel(); reject(new Error('فریم تازهٔ دوربین نرسید؛ دوربین را دوباره باز کنید.')); }, 2500);
        const handle = video.requestVideoFrameCallback((_now, metadata) => {
          abort.signal.removeEventListener('abort', cancel); clearTimeout(timeout);
          if (!video.videoWidth || !video.videoHeight || !Number.isSafeInteger(metadata.presentedFrames) || !Number.isFinite(metadata.mediaTime)) { reject(new Error('هویت فریم واقعی دوربین در دسترس نیست.')); return; }
          resolve({ presentedFrames: metadata.presentedFrames, mediaTime: metadata.mediaTime, width: video.videoWidth, height: video.videoHeight });
        });
        abort.signal.addEventListener('abort', cancel, { once: true });
      }));
      if (abort.signal.aborted) return;
      previewStream.current = crypto.randomUUID();
      const prepare = (body: LivePreviewInput): LivePreviewInput => {
        const current = patchGetter.current();
        const { feedback, ...target } = body;
        const same = feedback && current?.rendered && current.layout === 'liveBands' && current.patchId === feedback.patchId && current.commandSequence === feedback.commandSequence && sameBandLayout(current, body.bands);
        return { ...target, ...(same ? { feedback } : {}) };
      };
      const pump = new LivePreviewPump(body => awaitWithSignal(abort.signal, () => previewApi.current.post<Patch>('live-preview', {...prepare(body),fingerprint:cameraRef.current?.fingerprint(),canvasColorSpace:colorSpaceRef.current,cameraAppearanceColorSpace:'srgb'})), command => {
        if (abort.signal.aborted) return;
        setPreviewCompensation(command.compensation);
        // Preview detection accepts any current marker; scientific capture still pins sequences.
        trackingSequence.current = undefined;
        configurePreviewDisplay();
        trace.add('workbench', 'stage', { phase: 'scene', commandSequence: command.commandSequence, bandCount: command.bands?.length });
      }, failure => { trace.add('preview','operation_error',{phase:'preview',code:diagnosticErrorCode(failure)});stopLivePreview(false); previewPausePending.current = true; setError(`${failure instanceof Error ? failure.message : 'پیش‌نمایش زنده متوقف شد.'} اتصال و صفحهٔ گوشی A را بررسی کنید؛ سپس نمایش زنده را دوباره شروع کنید.`); pause('live_preview_error'); }, prepare);
      previewPump.current = pump; previewStarting.current = false;
      abort.signal.addEventListener('abort', () => { pump.stop(); if (previewPump.current === pump) { previewPump.current = null; setLivePreview(false); } }, { once: true });
      pump.update({ streamId: previewStream.current, bands: [{ id: 'locator', drive: [0.5, 0.5, 0.5], top: 0, bottom: 1 }], mapping: 'orderedPreview', sourceFrame, warnings: ['orderedPreview', 'screenAlignmentUncertain', 'cameraControlsUnknown', 'uncalibratedPreview'] });
    } catch (failure) { const cancelled = abort.signal.aborted;trace.add('preview','operation_error',{phase:'preview',code:cancelled?'capture_aborted':diagnosticErrorCode(failure)}); stopLivePreview(false); if (!cancelled) setError(failure instanceof Error ? failure.message : 'پیش‌نمایش زنده شروع نشد.'); }
  };
  const prepareManualResponse = () => action(async () => {
    if (mode !== 'cameraMatch' || !cameraRef.current || !videoRef.current || !liveRef.current.cameraReady) throw new Error('ابتدا دوربین را باز کنید.');
    if (previewPump.current || previewStarting.current) stopLivePreview();
    const abort = controller(false);
    await waitForPreviewPause(abort.signal);
    waitingResume.current = true;
    try {
      let state = await awaitWithSignal(abort.signal, readServer);
      if (!(state.capabilities as { display?: unknown } | undefined)?.display) throw new Error('گوشی A را وصل کنید.');
      if (state.paused) {
        if (!send('session.resume', { witnessChecked: true })) throw new Error('اتصال جلسه برقرار نیست.');
        const deadline = performance.now() + 12000;
        do {
          state = await awaitWithSignal(abort.signal, readServer);
          if (!state.paused) break;
          await awaitWithSignal(abort.signal, () => new Promise<void>(resolve => setTimeout(resolve, 80)));
        } while (performance.now() < deadline);
        if (state.paused) throw new Error('ادامهٔ جلسه از سرور تأیید نشد.');
      }
      registerAbort(abort);
      await requestPatch([.5, .5, .5], crypto.randomUUID());
      if (abort.signal.aborted) return;
      setAdvanced(true); setManualResponseSetup(true); setManualResponseConfirmed(false);
      setResponseStatus('پچ راه‌اندازی رندر شد؛ داخل سطح رنگ، یک کارت جدا و نوار نشانگر را رسم و تأیید کنید.');
    } finally { waitingResume.current = false; }
  }, false);
  const measureResponse = (useManual = false) => action(async () => {
    if (mode !== 'cameraMatch' || !cameraRef.current || !videoRef.current || !liveRef.current.cameraReady) throw new Error('ابتدا دوربین را باز کنید.');
    let manualGeometry: ResponseGeometry | undefined;
    if (useManual) {
      if (!manualResponseSetup || !manualResponseConfirmed) throw new Error('صفحه، کارت و نشانگر و ثابت‌بودن دوربین را تأیید کنید.');
      const screen = regionById(liveRef.current.roles.display, 'رنگ نمایشگر'), card = regionById(liveRef.current.roles.witness, 'کارت شاهد'), selectedMarker = liveRef.current.marker;
      if (!screen.operatorConfirmed || !card.operatorConfirmed) throw new Error('هندسهٔ هر دو ناحیه را تأیید کنید.');
      const width = videoRef.current.videoWidth, height = videoRef.current.videoHeight;
      const boxes = [screen, card].map(region => {
        normalizedRegion(region, width, height);
        if ([region.polygon, ...region.exclusions].some(polygon => polygon.length < 3 || polygon.some(p => p.length !== 2 || p.some(v => !Number.isFinite(v))))) throw new Error('هندسهٔ ناحیه نامعتبر است.');
        const box = bounds(region.polygon);
        if (box.width <= 2 || box.height <= 2) throw new Error('ناحیه باید سطح واقعی داشته باشد.');
        return box;
      });
      if (!selectedMarker || !Object.values(selectedMarker).every(Number.isFinite) || selectedMarker.x < 0 || selectedMarker.y < 0 || selectedMarker.width < 112 || selectedMarker.height < 4 || selectedMarker.x + selectedMarker.width > width || selectedMarker.y + selectedMarker.height > height) throw new Error('نوار نشانگر را کامل داخل تصویر و حداقل ۱۱۲×۴ پیکسل انتخاب کنید.');
      boxes.push(selectedMarker);
      if (screen.id === card.id || boxes.some((a, index) => boxes.slice(index + 1).some(b => a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height))) throw new Error('صفحه، کارت شاهد و نشانگر باید جدا و بدون هم‌پوشانی باشند.');
      manualGeometry = structuredClone({ screen: { ...screen, selectionMethod: 'manual' }, card: { ...card, selectionMethod: 'manual' }, marker: selectedMarker, referenceRole: 'middle' });
    }
    if (previewPump.current || previewStarting.current) stopLivePreview();
    const abort = controller(false);
    responseRunning.current = true; manualResponseRunning.current = useManual; responseGeometry.current = manualGeometry ?? null; setResponseBusy(true); setResult(null);
    setResponseStatus('یک کارت خاکستری جدا کنار گوشی A بگذارید؛ همان کارت در تمام فرمان‌ها ثابت می‌ماند.');
    try {
      await waitForPreviewPause(abort.signal);
      let state = await awaitWithSignal(abort.signal, () => api.get()); serverRef.current = state;
      if (!(state.capabilities as { display?: unknown } | undefined)?.display) throw new Error('گوشی A را با QR وصل کنید و صفحه را باز نگه دارید.');
      if (state.paused) {
        waitingResume.current = true;
        try {
          if (!send('session.resume', { witnessChecked: true })) throw new Error('اتصال جلسه برقرار نیست.');
          const deadline = performance.now() + 12000;
          do {
            state = await awaitWithSignal(abort.signal, () => api.get()); serverRef.current = state;
            if (!state.paused) break;
            await awaitWithSignal(abort.signal, () => new Promise<void>(resolve => setTimeout(resolve, 80)));
          } while (performance.now() < deadline);
          if (state.paused) throw new Error('ادامهٔ جلسه از سرور تأیید نشد.');
        } finally { waitingResume.current = false; }
      }
      registerAbort(abort); if (!useManual) clearGeometry(); trackerRef.current?.resetBaseline();
      const video = videoRef.current, camera = cameraRef.current;
      const context = { fingerprint: camera.fingerprint(), width: video.videoWidth, height: video.videoHeight, streamId: crypto.randomUUID() };
      const report = await runResponseGuide({ context, signal: abort.signal, fingerprint: () => camera.fingerprint(), post: (route, body) => api.post(route, body),
        // Session pause is the existing lifecycle cancellation fallback until the run endpoint replies.
        cancel: async () => { send('session.pause', { reason: 'operator_pause' }); },
        progress: text => { setProgress(text); setResponseStatus(text); },
        wait: async (command: ResponseCommand) => {
          configureTracking('scene', command.commandSequence);
          const patch = await waitForPatch(() => patchGetter.current(), command.patchId!, command.commandSequence!, abort.signal);
          if (patch.commandSequence !== command.commandSequence) throw new Error('فرمان نمایشگر عوض شد.');
        },
        geometry: async () => {
          if (manualGeometry) {
            if (abort.signal.aborted) throw new Error('جلسه متوقف شد.');
            return manualGeometry;
          }
          const deadline = performance.now() + 15000;
          do {
            const current = trackingRef.current;
            const middle = current?.neutralCardRegions?.find(card => card.role === 'middle')?.region;
            const screen = current?.regions.find(region => region.id === 'auto-display' || /display|screen/.test(region.id));
            const recent = lastTrackingReceipt.current !== null && performance.now() - lastTrackingReceipt.current < 2500;
            if (current && current.status==='ready' && (current.geometryStable || current.relativeGeometryStable === true) && recent && !current.pixelMoving && !current.surfaceChanged && current.marker && middle && screen && current.frame.width === context.width && current.frame.height === context.height && current.evidence.markerSequence === trackingSequence.current) {
              const clean = (region: Region): Region => ({ id: region.id, label: region.label, order: region.order, mode: region.mode, polygon: region.polygon, exclusions: region.exclusions, background: region.background, direction: region.direction, layers: region.layers, operatorConfirmed: false, selectionMethod: 'autoDetected' });
              const frozen=responseGeometry.current;
              if(frozen&&[screen,middle].some((region,index)=>{
                const prior=[frozen.screen,frozen.card][index],xs=prior.polygon.map(p=>p[0]),ys=prior.polygon.map(p=>p[1]);
                const tolerance=Math.max(2,Math.min(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))*.04);
                return region.id!==prior.id||region.polygon.length!==prior.polygon.length||region.polygon.some(p=>!prior.polygon.some(q=>Math.hypot(p[0]-q[0],p[1]-q[1])<=tolerance));
              }))throw new Error('همان کارت شاهد یا هندسهٔ صفحه جابه‌جا شد؛ برداشت متوقف شد.');
              const geometry: ResponseGeometry = { screen: frozen?.screen??clean(screen), card: frozen?.card??clean(middle), marker: current.marker, referenceRole: 'middle' };
              responseGeometry.current = geometry; setRegions([geometry.screen, geometry.card]); setMarker(geometry.marker);
              return geometry;
            }
            setResponseStatus(current?.nextAction??'یک کارت خاکستری جدا کنار A بگذارید؛ منتظر نشانگر واقعی و سه تشخیص پایدار صفحه و همان شاهد هستیم.');
            await awaitWithSignal(abort.signal, () => new Promise<void>(resolve => setTimeout(resolve, 80)));
          } while (performance.now() < deadline);
          throw new Error(`صفحه یا یک کارت شاهد پیدا نشد؛ ${trackingRef.current?.nextAction??'یک کارت جدا کنار A بگذارید.'}`);
        },
        capture: async (command, geometry) => {
          if (video.videoWidth !== context.width || video.videoHeight !== context.height) throw new Error('ابعاد واقعی دوربین تغییر کرد.');
          const patch = patchGetter.current();
          if (!patch?.rendered || patch.patchId !== command.patchId || patch.commandSequence !== command.commandSequence) throw new Error('فرمان جاری هنوز رندر نشده است.');
          if (!pipelineRef.current) pipelineRef.current = new CapturePipeline();
          return pipelineRef.current.captureRelative(video, [geometry.screen, geometry.card], camera, abort.signal, geometry.marker, command.commandSequence!, colorSpaceRef.current);
        } });
      if (abort.signal.aborted) return;
      setResult(report);
      const holdout = (report.validation as { holdout?: { mean?: number; max?: number } } | undefined)?.holdout;
      setResponseStatus(`جبران پاسخ نمایشگر از دید دوربین، آزمایشی · مدل آماده · خطای holdout در RGB نرمال‌شدهٔ دوربین: میانگین ${holdout?.mean?.toFixed(4) ?? 'نامعلوم'}، بیشینه ${holdout?.max?.toFixed(4) ?? 'نامعلوم'}`);
      await awaitWithSignal(abort.signal, async () => { await refresh(); });
    } catch (failure) {
      setResponseStatus(abort.signal.aborted ? 'اندازه‌گیری لغو شد؛ نتیجهٔ ناقص فعال نیست و پاسخ دیررس پذیرفته نمی‌شود.' : `مدل پاسخ آماده نیست / اعتبارسنجی رد شد: ${failure instanceof Error ? failure.message : 'خطای برداشت'}`);
      throw failure;
    } finally { responseRunning.current = false; manualResponseRunning.current = false; responseGeometry.current = null; setResponseBusy(false); setManualResponseConfirmed(false); configureTracking('scene'); }
  }, false);
  const clearGeometry = () => {
    setManualResponseSetup(false); setManualResponseConfirmed(false);
    sceneRef.current = null; setScene(null); setRegions([]); setMarker(null); setBindings({}); setCardPatchId(''); setDisplayRoi(''); setWitnessRoi(''); setCardRoi(''); setFabricRoi(''); setObservations([]); setCapturedReferenceKey('');
    liveRef.current = { ...liveRef.current, regions: [], marker: null, bindings: {}, roles: { display: '', witness: '', card: '', fabric: '' }, cardPatchId: '' };
  };
  const configureTracking = (phase: TrackingPhase, expectedSequence?: number) => {
    const purpose=responseRunning.current?'response':undefined;
    if (trackingPhase.current === phase && trackingSequence.current === expectedSequence && trackingPurpose.current===purpose) return;
    trackingPurpose.current=purpose;
    trackingPhase.current = phase; trackingSequence.current = expectedSequence; trackingRef.current = null; setTracking(null); lastObservation.current = null; lastTrackingReceipt.current = null;
    commandGraceUntil.current = performance.now() + 2500;
    trackerRef.current?.configure({ phase, expectedSequence, mode,purpose });
    trace.add('tracking', 'configuration', { phase, expectedSequence });
  };
  const sameBandLayout = (patch: Patch, bands: LivePreviewInput['bands']) => patch.bands?.length === bands.length && bands.every((band, index) => {
    const displayed = patch.bands![index];
    return displayed.id === band.id && displayed.top === band.top && displayed.bottom === band.bottom;
  });
  const configurePreviewDisplay = () => {
    if (!previewPump.current) return;
    const patch = patchGetter.current();
    const displayBands = patch?.rendered && patch.layout === 'liveBands' && patch.bands ? { commandSequence: patch.commandSequence, bands: patch.bands } : undefined;
    const key = JSON.stringify(displayBands) ?? '';
    if (key === previewDisplayKey.current) return;
    previewDisplayKey.current = key;
    trackerRef.current?.configure({ displayBands });
  };
  useEffect(() => { configurePreviewDisplay(); });
  const waitForStable = async (signal: AbortSignal, expectedSequence?: number) => {
    if (expectedSequence !== undefined) configureTracking('scene', expectedSequence);
    const deadline = performance.now() + 6500;
    do {
      const current = trackingRef.current;
      if (current?.phase === trackingPhase.current && current.fresh !== false && lastTrackingReceipt.current !== null && performance.now() - lastTrackingReceipt.current < 2500 && current.geometryStable && current.status === 'ready' && !current.moving && (expectedSequence === undefined || current.evidence.markerSequence === expectedSequence)) return;
      await awaitWithSignal(signal, () => new Promise<void>(resolve => setTimeout(resolve, 80)));
    } while (performance.now() < deadline);
    throw new Error('سه تشخیص پایدار از قاب تازه لازم است؛ کادر را ثابت کنید و دوباره شروع کنید.');
  };
  trackingUpdate.current = value => {
    if (value.phase !== trackingPhase.current) return;
    if (value.expectedSequence !== undefined && value.expectedSequence !== trackingSequence.current) return;
    const command = patchGetter.current()?.commandSequence;
    if (!previewPump.current && !previewStarting.current && value.phase === 'scene' && command !== undefined && command !== trackingSequence.current) { configureTracking('scene', command); return; }
    trackingRef.current = value; setTracking(value);
    if(value.status!=='waiting'&&value.status!=='error'&&value.frame.presentedFrames>0){const evidenceSnapshot=observedEvidence(value,patchGetter.current());if(evidenceSnapshot)trace.add('tracking','evidence',{evidenceSnapshot,...value.evidence,markerSentinels:value.debug?.markerSentinels,markerRejections:value.debug?.markerRejections});}
    const receivedAt = performance.now(); setTrackingClock(receivedAt);
    if ((value.fresh !== false || value.frame.timeSource === 'callbackClock') && value.status !== 'waiting' && value.status !== 'error') { lastTrackingReceipt.current = receivedAt; lastObservation.current = { value, receivedAt }; completedReceipts.current++; }
    if (value.frame.width && value.frame.height) setDimensions({ width: value.frame.width, height: value.frame.height });
    const state = `${value.phase}:${value.status}:${value.geometryStable}:${value.moving}`;
    if (state !== lastTrackingTrace.current || performance.now() - lastTrackingTraceAt.current >= 1000) { trace.add('tracking', 'geometry', { phase: value.phase, status: value.status, stable: value.geometryStable, moving: value.moving, fresh: value.fresh, surfaceChanged: value.surfaceChanged, reason: value.debug?.reason, ...value.debug,...value.evidence, ...value.frame, processingMs: value.processingMs }); lastTrackingTrace.current = state; lastTrackingTraceAt.current = performance.now(); }
    if (previewStarting.current) return;
    if (responseRunning.current) {
      if (manualResponseRunning.current) return;
      // Dedicated response tracking scores the witness, not changing screen colors or cloth.
      if (responseGeometry.current && (value.pixelMoving || value.surfaceChanged)) {
        activeAbort.current?.abort(); send('session.pause', { reason: 'camera_moved' });
        setResponseStatus('قاب یا کارت تغییر کرد؛ اندازه‌گیری لغو شد و پروفایل قبلی معتبر نیست.');
      }
      return;
    }
    if (previewPump.current) {
      configurePreviewDisplay();
      if ((value.fresh !== false || value.frame.timeSource === 'callbackClock') && value.status !== 'waiting' && value.status !== 'error' && value.frame.presentedFrames > 0 && value.frame.mediaTime >= 0) {
        const bands = value.previewBands?.slice(0, 32).map(b => ({ id: b.id, drive: b.previewRgb, top: b.top, bottom: b.bottom })) ?? [];
        const mapping = value.previewMapping ?? 'orderedPreview';
        const warnings = [...new Set([...(value.previewWarnings ?? []), 'cameraControlsUnknown', 'uncalibratedPreview', ...(mapping === 'orderedPreview' ? ['orderedPreview', 'screenAlignmentUncertain'] : [])])].filter(warning => ['partialBand', 'orderedPreview', 'screenAlignmentUncertain', 'cameraControlsUnknown', 'uncalibratedPreview'].includes(warning));
        const sourceFrame = { presentedFrames: value.frame.presentedFrames, mediaTime: value.frame.reportedMediaTime ?? value.frame.mediaTime, width: value.frame.width, height: value.frame.height };
        const patch = patchGetter.current(), measured = value.previewFeedback;
        let feedback: LivePreviewInput['feedback'];
        if (measured && patch?.rendered && patch.layout === 'liveBands' && sameBandLayout(patch, bands) && measured.markerSequence === patch.commandSequence && value.evidence.markerSequence === patch.commandSequence && value.status === 'ready' && (value.geometryStable || value.relativeGeometryStable === true && value.frame.timeSource === 'callbackClock' && value.frame.reportedMediaTime === 0) && !value.moving && !value.pixelMoving && !value.surfaceChanged && measured.screenAppearanceBands.length === bands.length && measured.screenAppearanceBands.every((band, index) => band.id === bands[index].id)) {
          try {
            if (decodeMarker(measured.markerPixels) === patch.commandSequence) feedback = { commandSequence: patch.commandSequence, patchId: patch.patchId, markerPixels: measured.markerPixels, screenRoi: measured.screenRoi, screenAppearanceBands: measured.screenAppearanceBands, stable: true };
          } catch { /* Unreadable physical evidence cannot authorize correction. */ }
        }
        previewPump.current.update({ streamId: previewStream.current, bands, mapping, sourceFrame, warnings, ...(feedback ? { feedback } : {}) });
        setPreviewStatus(!bands.length ? 'در حال پیدا کردن نوارها' : value.moving ? 'دوربین در حرکت است؛ پیش‌نمایش به‌روز می‌شود، اندازه‌گیری دقیق متوقف می‌ماند.' : `نوارها دیده شد؛ گوشی A ${mapping === 'screenAligned' ? 'با هم‌ترازی تخمینی به‌روز می‌شود؛ زاویه و پرسپکتیو تأیید نشده.' : 'ترتیب نوارها را نشان می‌دهد؛ هم‌ترازی هنوز نامعلوم است.'}`);
      } else setPreviewStatus('فریم تازه نرسید؛ تصویر قبلی موقت است و سپس کنار گذاشته می‌شود.');
      return;
    }
    const lost = value.status !== 'ready' && value.status !== 'waiting';
    // A new display command deliberately makes the previous marker unreadable briefly.
    // Ready-geometry motion still aborts immediately; missing-marker loss gets a bounded grace.
    const changedSurface = value.pixelMoving || value.surfaceChanged;
    if (!advanced && (changedSurface || ((value.moving || lost || value.fresh === false) && (value.status === 'ready' || performance.now() >= commandGraceUntil.current)))) {
      clearGeometry();
      if (busyRef.current && activeAbort.current && !activeAbort.current.signal.aborted) { movedPause.current = true; stopAutomation('camera_moved'); setNeutralReport(null); setError('قاب حرکت کرد یا ناحیه گم شد؛ برداشت لغو شد. کادر را ثابت کنید، شرایط را دوباره تأیید کنید و شروع را بزنید.'); }
    }
  };
  useEffect(() => {
    if (!cameraActive || mode === 'replay' || !videoRef.current) return;
    const tracker = new LiveTracker(videoRef.current, value => trackingUpdate.current(value), { phase: trackingPhase.current, expectedSequence: trackingSequence.current, mode, onFrame: frame => { cameraHeartbeat.current = { callbacks: cameraHeartbeat.current.callbacks + 1, lastAt: performance.now() }; if (!document.hidden && previewPump.current && !previewAbort.current?.signal.aborted) previewPump.current.heartbeat({ presentedFrames: frame.presentedFrames, mediaTime: frame.reportedMediaTime ?? frame.mediaTime, width: frame.width, height: frame.height }, previewStream.current); }, onError: failure => { const wasLive = previewPump.current !== null; stopLivePreview(false); if (wasLive) pause('live_preview_error'); setError(`خطای واقعی ردیابی: ${failure.message} پیش‌نمایش دوربین باز است، اما اندازه‌گیری بدون ردیابی پایدار شروع نمی‌شود.`); } });
    trackerRef.current = tracker; tracker.start();
    return () => { tracker.stop(); if (trackerRef.current === tracker) trackerRef.current = null; };
  }, [cameraActive, mode]);
  const geometryChanged = () => { setAlignmentChecked(false); setManualResponseConfirmed(false); setObservations([]); if (busyRef.current) stopAutomation('roi_changed'); };
  const assignRole = (role: string) => { geometryChanged(); setDrawRole(role); editorRef.current?.querySelector<HTMLButtonElement>('button')?.click(); };
  const changeRegions = (updated: Region[]) => {
    geometryChanged();
    const added = updated.filter(r => !liveRef.current.regions.some(old => old.id === r.id));
    if (added.length === 1) {
      const addedRegion = added[0];
      const label = drawRole.startsWith('reference:') ? `پچ کارت ${drawRole.slice(10)}` : ({ display: 'رنگ نمایشگر A', witness: 'شاهد خنثی', card: 'کارت مرجع', fabric: 'پارچه' } as Record<string, string>)[drawRole] ?? 'پارچه';
      updated = updated.map(r => r.id === addedRegion.id ? { ...r, label, operatorConfirmed: false } : r);
      if (drawRole.startsWith('reference:')) setBindings(b => ({ ...b, [drawRole.slice(10)]: addedRegion.id }));
      else if (drawRole === 'display') setDisplayRoi(addedRegion.id);
      else if (drawRole === 'witness') setWitnessRoi(addedRegion.id);
      else if (drawRole === 'card') setCardRoi(addedRegion.id);
      else if (!fabricRoi) setFabricRoi(addedRegion.id);
    }
    setRegions(updated);
  };
  const resumeAfterCheck = async (signal: AbortSignal) => {
    if (!alignmentChecked) throw new Error('شاهد و شرایط ثابت را ابتدا بررسی و تأیید کنید.');
    waitingResume.current = true;
    try {
      if (!send('session.resume', { witnessChecked: true })) throw new Error('اتصال جلسه برقرار نیست.');
      const deadline = performance.now() + 12000;
      do {
        const state = await awaitWithSignal(signal, readServer);
        if (!state.paused) return;
        await awaitWithSignal(signal, () => new Promise<void>(resolve => setTimeout(resolve, 80)));
      } while (performance.now() < deadline);
      throw new Error('سرور ادامهٔ جلسه را تأیید نکرد؛ اتصال دو گوشی را بررسی کنید.');
    } finally { waitingResume.current = false; }
  };
  const runAutomatic = () => action(async () => {
    if (previewPump.current || previewStarting.current) { stopLivePreview(); throw new Error('نمایش زنده متوقف شد؛ برای تطبیق دقیق شرایط ثابت را دوباره تأیید کنید.'); }
    if (!liveRef.current.cameraReady) throw new Error('ابتدا «بازکردن دوربین و دیدن کادر» را بزنید؛ اندازه‌گیری دوربین را پنهانی باز نمی‌کند.');
    if (!advanced && (mode === 'cameraMatch' || mode === 'threeStage') && !neutralDoneRef.current && trackingPhase.current !== 'cards') configureTracking('cards');
    if (!advanced && trackingPhase.current === 'cards' && (!trackingRef.current?.geometryStable || trackingRef.current.fresh === false)) throw new Error('سه تشخیص پایدار از قاب تازه لازم است؛ کادر را ثابت کنید و دوباره شروع کنید.');
    movedPause.current = false;
    setMeasurementStarted(true);
    const abort = controller(advanced && !previewPausePending.current); setQueue([]);
    await waitForPreviewPause(abort.signal);
    if (!advanced) {
      if (mode === 'catalogOnly') throw new Error('فقط کاتالوگ به نمایشگر نیاز ندارد؛ نگاشت خودکار کارت این مسیر هنوز پشتیبانی نمی‌شود. مرجع واقعی لازم است و به مسیر سه‌مرحله‌ای تبدیل نشده است.');
      if ((mode === 'cameraMatch' || mode === 'threeStage') && !neutralDoneRef.current) { await prepareNeutralCards(abort.signal); registerAbort(abort); return; }
      if (mode === 'threeStage' && actualReference?.validity !== 'verified') throw new Error('برای کالیبراسیون کامل مرجع رنگی با مقادیر معتبر نیاز است؛ سه کارت خنثی فقط کنترل محدود هستند. مرجع واقعی را در تنظیمات کامل ثبت کنید.');
      await prepareScene(abort.signal);
      registerAbort(abort);
      if (mode !== 'cameraMatch' && sceneRef.current?.status !== 'ready') throw new Error(sceneRef.current?.nextAction ?? 'چیدمان هنوز آماده نیست.');
    }
    const current = await awaitWithSignal(abort.signal, readServer);
    const missing = nextLiveRequirement({ ...getContext(), snapshot: current.paused && alignmentChecked ? { ...current, paused: false } : current });
    if (missing) throw new Error(missing.text);
    if (current.paused) await resumeAfterCheck(abort.signal);
    try {
      const item = (item: LiveItem) => { setQueue(rows => { const index = rows.findIndex(row => row.regionId === item.regionId); return index < 0 ? [...rows, item] : rows.map((row, i) => i === index ? item : row); }); if (item.measurement) setResult(item.measurement); };
      const base = { getContext, readServer, capture, fingerprint: () => cameraRef.current!.fingerprint(), post: (route: string, body: unknown) => api.post<Record<string, unknown>>(route, body), signal: abort.signal, progress: setProgress, item };
      if (mode === 'cameraMatch') await runCameraMatchQueue({ ...base, match: async (fabric, targetFrames, signal) => {
        const match = await runCameraMatch(fabric, liveRef.current.width, liveRef.current.height, { request: requestPatch, capture: command => loopCapture(command, fabric, signal), post: base.post, signal, progress: setProgress, targetFrames });
        setMatches(rows => [...rows, match]); setResult(match); return match;
      } });
      else await runLiveAutomation({ ...base,
        grid: signal => runGrid({ request: requestPatch, capture: command => loopCapture(command, undefined, signal), post: (route, body) => api.post(route, body), signal, progress: setProgress, fingerprint: cameraRef.current!.fingerprint(), cardPatchId: liveRef.current.cardPatchId }),
        match: async (id, fabric, signal) => {
          // Bind this sample synchronously in the closure, not by waiting for a React render.
          const match = await runMatch(id, { request: requestPatch, capture: command => loopCapture(command, fabric, signal), post: (route, body) => api.post(route, body), signal, progress: setProgress, cardPatchId: liveRef.current.cardPatchId });
          setMatches(rows => [...rows, { ...match, measurementId: id }]); setResult(match); return match;
        } });
      await awaitWithSignal(abort.signal, readServer);
    } catch (error) { setQueue(rows => rows.map(row => ['queued', 'capturing', 'matching'].includes(row.status) ? { ...row, status: 'stopped' } : row)); if (!movedPause.current) stopAutomation('automatic_run_interrupted'); throw error; }
  }, false);
  const suggestSamples = () => action(async () => {
    if (!videoRef.current || !cameraActive) throw new Error('دوربین زنده را ابتدا فعال کنید.');
    const fabric = regionById(fabricRoi, 'پارچه'); const abort = controller();
    const proposals = await awaitWithSignal(abort.signal, () => suggestLiveRegions(videoRef.current!, fabric));
    if (!proposals.length) throw new Error('ناحیه‌ای پیشنهاد نشد؛ مستطیل پارچه را بازبینی کنید.');
    geometryChanged(); const existing = liveRef.current.regions.filter(r => r.id !== fabric.id); const updated = proposals.map((r, index) => ({ ...r, order: fabric.order + index, operatorConfirmed: false }));
    if (existing.length + updated.length > 32) throw new Error('سقف ۳۲ ناحیه؛ پیشنهادها را کاهش دهید.');
    setRegions([...existing, ...updated].sort((a, b) => a.order - b.order).map((r, index) => ({ ...r, order: index + 1 }))); setFabricRoi(updated[0].id); setSuggestedIds(updated.map(r => r.id));
  });
  const openCamera = async (signal?: AbortSignal) => {
    stopLivePreview(false);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('دوربین به HTTPS معتبر یا localhost و مجوز مرورگر نیاز دارد.');
    if (signal) send('session.pause', { reason: 'camera_selection_changed' }); else pause('camera_selection_changed'); setObservations([]);
    trackerRef.current?.stop(); setCameraActive(false); clearGeometry(); cameraHeartbeat.current = { callbacks: 0, lastAt: 0 }; lastObservation.current = null; lastTrackingReceipt.current = null; completedReceipts.current = 0; trackingRef.current = null; setTracking(null); neutralDoneRef.current = false; setNeutralDone(false); setNeutralReport(null); configureTracking(mode === 'cameraMatch' || mode === 'threeStage' ? 'cards' : 'scene');
    const camera = new Camera(navigator.mediaDevices, reason => { stopLivePreview(false); activeAbort.current?.abort(); pause(reason); send('profile.invalidate', { reason }); clearGeometry(); if (reason === 'camera_track_ended') { trackerRef.current?.stop(); setCameraActive(false); liveRef.current = { ...liveRef.current, cameraReady: false }; setError('جریان دوربین پایان یافت؛ دوربین را دوباره باز کنید.'); } }); cameraRef.current?.stop(); cameraRef.current = camera;
    const wait = <T,>(work: () => Promise<T>) => signal ? awaitWithSignal(signal, work) : work();
    try {
      const stream = await wait(() => camera.start(deviceId || undefined));
      if (!videoRef.current) throw new Error('پیش‌نمایش دوربین در دسترس نیست.');
      videoRef.current.srcObject = stream; await wait(() => videoRef.current!.play());
      const actual = camera.track?.getSettings().deviceId; if (actual) setDeviceId(actual);
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'));
      setCameraActive(true); setMeasurementStarted(false); liveRef.current = { ...liveRef.current, cameraReady: true }; const report = { ...camera.report(), canvasColorSpace: 'unknown' }; setCameraReport(report); send('capabilities.report', report);
      send('profile.invalidate', { reason: 'camera_selection_changed' });
    } catch (error) { camera.stop(); if (videoRef.current) videoRef.current.srcObject = null; setCameraActive(false); liveRef.current = { ...liveRef.current, cameraReady: false }; throw error; }
  };
  const startCamera = () => action(() => openCamera(), false);
  const sceneRef = useRef<LiveScene | null>(null);
  const prepareLiveCamera = async (signal: AbortSignal) => {
    if (!liveRef.current.cameraReady) throw new Error('ابتدا «بازکردن دوربین و دیدن کادر» را بزنید.');
    try { await awaitWithSignal(signal, readServer); if (serverRef.current.paused) await resumeAfterCheck(signal); }
    finally { waitingResume.current = false; }
  };
  const prepareNeutralCards = async (signal: AbortSignal) => {
    await prepareLiveCamera(signal);
    setProgress('سه کارت تیره، میانی و روشن را داخل قاب بگذارید؛ تشخیص و برداشت خودکار است.');
    const report = await runNeutralGuide({ scan: () => scanCards(videoRef.current!, signal), capture, post: (route, body) => api.post<Record<string, unknown>>(route, body), fingerprint: () => cameraRef.current!.fingerprint(), signal,
      overlay: rows => { liveRef.current = { ...liveRef.current, regions: rows, marker: null, roles: { display: '', witness: '', card: '', fabric: '' } }; setRegions(rows); setMarker(null); setDisplayRoi(''); setWitnessRoi(''); setCardRoi(''); setFabricRoi(''); setScene(null); } });
    await awaitWithSignal(signal, readServer);
    neutralDoneRef.current = true; setNeutralDone(true); setNeutralReport(report); setResult(report);
    clearGeometry(); configureTracking('scene', getPatch()?.commandSequence);
    setProgress(mode === 'threeStage' ? 'کنترل محدود کارت‌ها انجام شد؛ برای کالیبراسیون کامل مرجع رنگی با مقادیر معتبر نیاز است.' : 'کارت‌ها بررسی شدند؛ حالا پارچه و گوشی نمایشگر را کنار هم داخل قاب بگذارید.');
  };
  const prepareScene = async (signal: AbortSignal) => {
    // A user-requested new arrangement is not the frozen scene of an old run.
    configureTracking('scene', getPatch()?.commandSequence);
    trackerRef.current?.resetBaseline();
    trackingRef.current = null; setTracking(null);
    commandGraceUntil.current = performance.now() + 6500;
    trace.add('tracking', 'baselineReset', { reason: 'explicit_new_scene' });
    await prepareLiveCamera(signal);
    if (!(serverRef.current.capabilities as { display?: unknown } | undefined)?.display) throw new Error('گوشی A را با QR وصل کنید و صفحهٔ آن را باز نگه دارید.');
    setProgress('تشخیص خودکار نمایشگر، نشانگر و نمونه‌های پارچه');
    const command = await awaitWithSignal(signal, () => requestPatch([0.5, 0.5, 0.5], crypto.randomUUID()));
    const detected = await awaitWithSignal(signal, () => scanScene(videoRef.current!, command.commandSequence, signal, mode));
    sceneRef.current = detected; setScene(detected);
    const width = videoRef.current!.videoWidth || liveRef.current.width, height = videoRef.current!.videoHeight || liveRef.current.height;
    const mapped = mode !== 'cameraMatch' && actualReference ? suppliedReferenceRegions(actualReference, detected, width, height) : null;
    const next = [...sceneRegions(detected), ...(mapped?.regions ?? [])];
    const roles = { display: detected.displayRegion?.id ?? '', witness: mapped?.witnessId ?? '', card: mapped?.cardId ?? '', fabric: detected.fabricRegions[0]?.id ?? '' };
    liveRef.current = { ...liveRef.current, regions: next, marker: detected.marker ?? null, roles, bindings: mapped?.bindings ?? {}, cardPatchId: mapped?.cardPatchId ?? '', width, height };
    setRegions(next); setMarker(detected.marker ?? null); setDisplayRoi(roles.display); setWitnessRoi(roles.witness); setCardRoi(roles.card); setFabricRoi(roles.fabric); setBindings(mapped?.bindings ?? {}); setCardPatchId(mapped?.cardPatchId ?? '');
    if (detected.status !== 'ready') throw new Error(detected.nextAction);
    if (mode !== 'cameraMatch' && !mapped) throw new Error(actualReference ? 'کارت ثبت‌شده چیدمان قابل شناسایی خودکار ندارد؛ پچ‌ها و شاهد از تصویر حدس زده نمی‌شوند. تطبیق کامل هنوز برای این کارت قابل شروع نیست.' : guidedSceneAction(detected, mode, false));
  };
  const detectArrangement = () => action(async () => { const abort = controller(false); if ((mode === 'cameraMatch' || mode === 'threeStage') && !neutralDoneRef.current) await prepareNeutralCards(abort.signal); else { if (mode === 'threeStage' && actualReference?.validity !== 'verified') throw new Error('برای کالیبراسیون کامل مرجع رنگی با مقادیر معتبر نیاز است؛ مرجع واقعی را در تنظیمات کامل ثبت کنید.'); await prepareScene(abort.signal); } registerAbort(abort); }, false);
  const skipCards = () => { neutralDoneRef.current = true; setNeutralDone(true); setNeutralReport(null); clearGeometry(); configureTracking('scene', getPatch()?.commandSequence); setProgress('بررسی کارت‌ها صریحاً رد شد؛ فقط تطبیق آزمایشی. پارچه و نمایشگر کنار هم داخل قاب باشند.'); };
  const upload = (file: File) => action(async () => {
    if (!consent) throw new Error('رضایت ارسال کامل تصویر لازم است.');
    const form = new FormData(); form.append('file', file); form.append('retention', String(retention));
    const uploaded = await api.post<NonNullable<typeof image>>('images', form); setImage(uploaded); setDimensions({ width: uploaded.width, height: uploaded.height }); setRegions([]); setMarker(null);
    const response = await fetch(uploaded.previewUrl, { headers: { Authorization: `Bearer ${credentials.token}` }, cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`پیش‌نمایش canonical دریافت نشد (${response.status}).`);
    setPreview(URL.createObjectURL(await response.blob()));
  });
  const applyReference = () => action(async () => { const target = parseReference(referenceText, meta); setResult(await api.post('reference', target)); setReference(target); setExploratory(false); setObservations([]); });
  const addManual = () => {
    try {
      if (![manual.a, manual.b, manual.c].every(v => v.trim() && Number.isFinite(Number(v))) || !manual.id) throw new Error('شناسه و سه عدد محدود لازم است.');
      let target: Reference;
      try { target = parseReference(referenceText, meta); } catch { target = { ...meta, xyzScale: 1, patches: [], geometry: null, health: null }; }
      if (target.patches.some(p => p.id === manual.id)) throw new Error('شناسهٔ پچ تکراری است.');
      target.patches.push({ id: manual.id, values: [Number(manual.a), Number(manual.b), Number(manual.c)], split: manual.split as 'train' | 'holdout', neutral: manual.neutral }); setReferenceText(JSON.stringify(target, null, 2)); setError('');
    } catch (e) { setError((e as Error).message); }
  };
  const captureReference = () => action(async () => {
    if (!reference) throw new Error('ابتدا مرجع واقعی ثبت کنید.');
    const bound = reference.patches.map(p => ({ patch: p, region: regionById(bindings[p.id], p.id) }));
    if (new Set(bound.map(b => b.region.id)).size !== bound.length) throw new Error('هر پچ فیزیکی مرجع باید ناحیهٔ مستقل داشته باشد؛ train و holdout نباید یکی باشند.');
    const frames = await capture(bound.map(b => b.region), controller().signal); setObservations(bound.map((b, i) => ({ patchId: b.patch.id, frames: frames[i] }))); setCapturedReferenceKey(referenceCaptureKey(regions, bindings)); setResult({ capturedPatches: bound.length, uniqueFramesPerPatch: frames[0].length, controlLock: 'unknown' });
  });
  const measure = () => action(async () => {
    if (!regions.length) throw new Error('ابتدا ناحیه رسم کنید.');
    if (mode === 'replay') {
      if (!image) throw new Error('تصویر اصلی بارگذاری نشده است.');
      const response = await api.post<Record<string, unknown> | Record<string, unknown>[]>(`images/${encodeURIComponent(image.captureId)}/regions`, { regions: regions.map(r => normalizedRegion(r, dimensions.width, dimensions.height)) });
      const rows = Array.isArray(response) ? response : (response.measurements as Record<string, unknown>[] | undefined) ?? [response]; setMeasurements(m => [...m, ...rows]); setResult(Array.isArray(response) ? { measurements: response } : response);
    } else {
      const selected = fabricRegions(getContext());
      const abort = controller();
      for (const region of selected.sort((a, b) => a.order - b.order)) {
        setProgress(`برداشت ${region.order}: ${region.label}`);
        const paired = Boolean(witnessRoi && cardRoi && cardPatchId);
        const selected = paired ? [region, regionById(witnessRoi, 'شاهد خنثی'), regionById(cardRoi, 'کارت')] : [region];
        if (new Set(selected.map(r => r.id)).size !== selected.length) throw new Error('شاهد و کارت باید از نمونهٔ پارچه مستقل باشند.');
        const [frames, witnessFrames, cardFrames] = await capture(selected, abort.signal);
        const payload = measurementPayload(region, dimensions.width, dimensions.height, frames, witnessFrames, cardFrames, cardPatchId);
        const measurement = await api.post<Record<string, unknown>>('measurements', payload); setMeasurements(m => [...m, measurement]); setResult(measurement);
      }
    }
  });
  const exportFile = (format: 'json' | 'csv') => action(async () => {
    const content = await api.export(format, exportKind); const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `colorlab-${credentials.sessionId}-${exportKind}.${format}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const exportTrace = () => { const url = URL.createObjectURL(new Blob([trace.toJSON()], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'colorlab-diagnostics.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  const localEvidence=traceRows.filter(row=>row.sequence>traceSessionBoundary.current.sequence).map(row=>sanitizeEvidenceSnapshot(row.details.evidenceSnapshot)).filter((value):value is EvidenceSnapshot=>Boolean(value));
  const measurementId = (m: Record<string, unknown>) => String(m.id ?? m.measurementId ?? '');
  const groupCards = measurements.filter(m => m.displayStatus === 'complete' && Array.isArray(m.displayDriveRgb) && m.displayDriveRgb.length === 3 && m.displayDriveRgb.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1));
  const displayCapabilities = (snapshot.capabilities as { display?: { reportedSettings?: { width?: number; height?: number } } } | undefined)?.display?.reportedSettings;
  const groupSize = groupCapacity(displayCapabilities?.width ?? 390, displayCapabilities?.height ?? 720);
  const selector = (label: string, value: string, change: (value: string) => void) => <label>{label}<select value={value} onChange={e => { geometryChanged(); change(e.target.value); }}><option value="">انتخاب نشده</option>{regions.map(r => <option value={r.id} key={r.id}>{r.order}. {r.label}</option>)}</select></label>;
  const nextAction = advanced ? nextLiveRequirement(getContext()) : null;
  const receiptAge = lastTrackingReceipt.current === null ? null : Math.max(0, trackingClock - lastTrackingReceipt.current);
  const trackingCurrent = Boolean(cameraActive && tracking && tracking.fresh !== false && receiptAge !== null && receiptAge < 2500);
  const callbacks = Math.max(cameraHeartbeat.current.callbacks, tracking?.debug?.frameCallbacks ?? 0);
  const callbackAge = cameraHeartbeat.current.lastAt ? Math.max(0, trackingClock - cameraHeartbeat.current.lastAt) : null;
  const processingActive = tracking?.status === 'waiting' && Boolean(tracking.debug?.jobsStarted !== undefined && tracking.debug.jobsStarted > (tracking.debug.jobsCompleted ?? 0));
  const lastEvidence = lastObservation.current?.value.evidence;
  const startBlocked = !advanced ? (serverRef.current.paused && !alignmentChecked) || (cameraActive && trackingPhase.current === 'cards' && (!tracking?.geometryStable || !trackingCurrent)) : nextAction !== null && (nextAction.id !== 'paused' || !alignmentChecked);
  const steps = mode === 'replay' ? [['capture', 'تصویر و ناحیه‌ها'], ['fabric', 'پارچه و نتیجه'], ['report', 'گزارش و خروجی']] : [['capture', 'دوربین و ناحیه‌ها'], ['reference', '۱. مرجع و دوربین'], ...(mode === 'threeStage' ? [['display', '۲. جبران نمایشگر']] : []), ['fabric', '۳. پارچه و تطبیق'], ['report', 'گزارش و خروجی']];
  const currentStep = mode === 'replay' ? (measurements.length ? 'fabric' : 'capture') : snapshot.state === 'camera' ? 'reference' : snapshot.state;
  return <div className="workbench" aria-busy={busy}>
    <nav hidden={!advanced && mode !== 'replay'} className="stage-nav" aria-label="مسیر آزمایش"><div className="toolbar">{steps.map(([id, label]) => <a key={id} href={`#lab-${id}`} onClick={() => { if (id !== 'capture') setAdvanced(true); }} aria-current={currentStep === id ? 'step' : undefined}>{label}</a>)}</div><p className="hint">همهٔ بخش‌ها در دسترس‌اند؛ این پیوندها فقط جابه‌جایی در صفحه هستند، نه تکمیل مرحله یا عبور از کنترل کیفیت. {snapshot.paused ? 'جلسه متوقف است؛ شاهد را بررسی و ادامه را تأیید کنید.' : 'پیشرفت علمی فقط طبق وضعیت سرور است.'}</p></nav>
    <section className="panel" id="lab-capture"><div className="section-title"><h2>{mode === 'replay' ? 'دریافت تصویر و ناحیه‌ها' : 'نمای زنده'}</h2><output>{progress}</output></div>
      {mode !== 'replay' && <div className="toolbar"><button className="primary" disabled={busy} onClick={() => void startCamera()}>بازکردن دوربین و دیدن کادر</button><p role="status" aria-label="وضعیت پیش‌نمایش">{cameraActive ? measurementStarted ? 'دوربین باز است؛ وضعیت اندازه‌گیری در همین پنل است.' : 'دوربین باز است؛ هنوز اندازه‌گیری شروع نشده' : busy ? 'درخواست مجوز دوربین؛ منتظر پاسخ مرورگر' : 'دوربین بسته است؛ ابتدا کادر را ببینید.'}</p></div>}
      {mode === 'cameraMatch' && cameraActive && <aside className="live-preview-status" aria-label="کالیتهٔ زنده"><div className="toolbar"><button className="primary" disabled={busy || livePreview} onClick={() => void startLivePreview()}>نمایش زندهٔ کالیته</button><button disabled={!livePreview} onClick={() => stopLivePreview()}>توقف نمایش زنده</button></div><p role="status" aria-label="وضعیت کالیتهٔ زنده">{previewStatus}</p><p role="status" aria-label="نوع جبران کالیته">{previewCompensation?.status === 'measuredFeedbackExperimental' ? `بازخورد اندازه‌گیری‌شدهٔ صفحه، آزمایشی${previewCompensation.feedbackApplied === false ? '؛ اصلاح قبلی حفظ شده، بازخورد تازه نرسیده' : '؛ اصلاح فرمان از مشاهدهٔ واقعی صفحه'}` : previewCompensation?.status === 'cameraReferencedExperimental' ? 'جبران مدل پاسخ، بدون بازخورد تازهٔ صفحه، آزمایشی' : previewCompensation?.status === 'partiallyCompensatedExperimental' ? 'جبران مدل فقط برای بعضی نوارها؛ بقیه پیش‌نمایش خام هستند.' : 'پیش‌نمایش خام RGB دوربین؛ بازخورد صفحه هنوز پذیرفته نشده است.'}</p>{previewCompensation?.perBand?.map(band => <p key={band.id} aria-label={`خطای پیش از اصلاح نوار ${band.id}`}>{band.id}: {typeof band.residualBefore === 'number' && Number.isFinite(band.residualBefore) ? `خطای پیش از اصلاح در RGB دوربین ${band.residualBefore.toFixed(4)}` : 'خطای اندازه‌گیری‌شدهٔ صفحه در دسترس نیست'}{band.saturated ? '؛ محدودیت فرمان' : ''}{band.status === 'notCompensated' ? '؛ پیش‌نمایش خام، مدل این رنگ را پوشش نمی‌دهد' : ''}{band.warnings?.includes('previewFeedbackPlateau') ? '؛ خطا کاهش کافی نداشته، تطبیق تأیید نشده' : ''}</p>)}<p className="hint">زنده/آزمایشی: ظاهر رنگ در دوربین، نه رنگ فیزیکی پارچه، کالیبراسیون یا HEX کاتالوگ. گوشی A می‌تواند چپ یا راست کالیته باشد؛ حرکت دوربین پیش‌نمایش را به‌روز می‌کند، نه تأیید اندازه‌گیری را. خطا پیش از اصلاح است؛ کاهش خطا باید در قاب بعدی دوباره مشاهده شود.</p></aside>}
      {mode === 'cameraMatch' && cameraActive && <aside className="live-preview-status" aria-label="اندازه‌گیری پاسخ نمایشگر"><div className="toolbar"><button disabled={busy} onClick={() => void measureResponse()}>اندازه‌گیری پاسخ نمایشگر</button><button disabled={!responseBusy} onClick={() => stopAutomation()}>توقف اندازه‌گیری پاسخ</button></div><p role="status" aria-label="وضعیت پاسخ نمایشگر">{responseStatus}</p><p className="hint">همان کارت خاکستری را جدا کنار A در تمام فرمان‌ها ثابت نگه دارید؛ یک کارت شاهد کافی است. رنگ کارت عوض نمی‌شود و مقادیر فیزیکی آن نامعلوم است؛ کارت ۱۸٪ یا مرجع رنگی کامل فرض نمی‌شود. صفحهٔ A، نوار نشانگر و همهٔ لبه‌های کارت را داخل قاب بگذارید. نتیجه فقط پاسخ نمایشگر از دید همین دوربین است، نه ICC، ΔE یا تضمین تطبیق فیزیکی.</p>{tracking?.responseWitnessEvidence&&<p aria-label="دلیل انتخاب شاهد پاسخ">از {tracking.responseWitnessEvidence.candidateCount} کاندید، {tracking.responseWitnessEvidence.eligibleCount} شاهد میانی بیرون صفحه باقی ماند. دلایل رد: {Object.entries(tracking.responseWitnessEvidence.rejections).map(([reason,count])=>`${reason}: ${count}`).join('، ')||'ندارد'}. ترتیب پیشنهادی بر اساس فاصله از A: {tracking.responseWitnessEvidence.ordering.map(({index,distance})=>`${index+1} (${distance.toFixed(1)}px)`).join('، ')||'نامعلوم'}؛ چند شاهد مشابه خودکار انتخاب نمی‌شود.</p>}</aside>}
      {mode === 'threeStage' && <aside className="live-preview-status" aria-label="مرجع لازم برای حالت کامل"><p className="warning">سه کارت خنثی برای کنترل محدود هستند؛ برای کالیبراسیون کامل مرجع رنگی با مقادیر معتبر نیاز است. مقادیر واقعی این سه کارت نامعلوم است و کنترل آن‌ها مدل کامل رنگ ایجاد نمی‌کند.</p>{onChoosePreview && <button disabled={busy} onClick={onChoosePreview}>نمایش زندهٔ کالیته آزمایشی</button>}<p className="hint">پیش‌نمایش آزمایشی قابلیت جداگانه است؛ انتخاب آن جلسهٔ جدید می‌سازد و کالیبراسیون این جلسه را استفاده نمی‌کند. مرجع چندرنگ معتبر را می‌توانید از تنظیمات کامل وارد و ناحیه‌ها را دستی مشخص کنید.</p></aside>}
      {mode === 'cameraMatch' && cameraActive && <aside aria-label="بازیابی دستی پاسخ نمایشگر"><button disabled={busy} onClick={() => void prepareManualResponse()}>تعیین دستی صفحه و کارت</button>{manualResponseSetup && <><p className="warning">فقط بازیابی پاسخ آزمایشی: دوربین، صفحه و همان کارت باید ثابت بمانند. ردیابی خودکار جابه‌جایی در این مسیر معتبر نیست؛ نشانگر واقعی هر فریم، ۱۰ فریم هم‌زمان، تغییر شاهد و اعتبارسنجی سرور همچنان الزامی است. ابتدا ناحیهٔ داخلی رنگ صفحه و یک کارت جدا را رسم و هندسهٔ هر دو را تأیید کنید؛ سپس نوار نشانگر را جدا رسم کنید.</p><div className="field-grid">{selector('صفحهٔ پاسخ دستی', displayRoi, setDisplayRoi)}{selector('کارت شاهد پاسخ دستی', witnessRoi, setWitnessRoi)}</div><label><input type="checkbox" disabled={busy} checked={manualResponseConfirmed} onChange={e => setManualResponseConfirmed(e.target.checked)} />صفحه، کارت و نشانگر انتخاب‌شده و ثابت‌بودن دوربین را تأیید می‌کنم</label><button disabled={busy} onClick={() => void measureResponse(true)}>اندازه‌گیری پاسخ با ناحیه‌های انتخاب‌شده</button></>}</aside>}
      <style>{'#lab-capture .automatic-preview .region-editor > :not(.image-plane) { display: none; } #lab-capture .automatic-preview .image-plane svg { pointer-events: none; }'}</style>
      <div ref={editorRef} className={`camera-preview ${!advanced && mode !== 'replay' ? 'automatic-preview' : ''}`}><RegionEditor width={dimensions.width} height={dimensions.height} regions={regions} onChange={changeRegions} marker={marker} onMarker={roi => { geometryChanged(); setMarker(roi); }}>
        {mode === 'replay' ? preview && <img src={preview} alt="پیش‌نمایش canonical تصویر اصلی" /> : <video ref={videoRef} aria-label="پیش‌نمایش زندهٔ دوربین" muted playsInline autoPlay onLoadedMetadata={e => { const video = e.currentTarget; if (!waitingResume.current) geometryChanged(); if (video.videoWidth && video.videoHeight) setDimensions({ width: video.videoWidth, height: video.videoHeight }); setRegions([]); setMarker(null); }} />}
         {mode !== 'replay' && tracking && <svg className="tracking-overlay" aria-label="ردیابی ناحیه‌های زنده" style={!trackingCurrent ? { filter: 'grayscale(1)', opacity: 0.5 } : undefined} viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} preserveAspectRatio="none">{tracking.regions.map(r => <g key={r.id}><polygon className="roi" points={r.polygon.map(p => p.join(',')).join(' ')} /><text x={r.polygon[0][0]} y={r.polygon[0][1] + 24}>{r.label}{!trackingCurrent && ' (UNKNOWN)'}</text></g>)}{tracking.marker && <rect className="marker-roi" {...tracking.marker} />}<g aria-label="نامزدهای تأییدنشدهٔ ردیابی">{tracking.candidateRegions?.map(r => <g key={r.id}><polygon className="tracking-candidate" points={r.polygon.map(p => p.join(',')).join(' ')} /><text x={r.polygon[0][0]} y={r.polygon[0][1] + 24}>{r.label} (تأیید نشده)</text></g>)}</g></svg>}
      </RegionEditor></div>
      {mode!=='replay'&&<LiveDebugPanel api={api} cameraActive={cameraActive} capture={()=>videoRef.current?captureDebugFrame(videoRef.current,trackingRef.current):Promise.reject(new Error('دوربین باز نیست.'))}/>}
      {mode !== 'replay' && <p className="hint" aria-label="ابعاد گزارش‌شدهٔ دوربین">{(() => { const settings = (cameraReport?.reportedSettings ?? cameraRef.current?.track?.getSettings()) as MediaTrackSettings | undefined; return settings ? `${settings.width ?? 'نامعلوم'} × ${settings.height ?? 'نامعلوم'}${Number.isFinite(settings.frameRate) ? ` · ${settings.frameRate} fps` : ''} (فقط گزارش مرورگر؛ قفل سخت‌افزار نامعلوم)` : 'ابعاد و نرخ فریم هنوز گزارش نشده‌اند.'; })()}</p>}
      {mode !== 'replay' && error && <p className="error" role="alert">{error}</p>}
      <DiagnosticEvidencePanel snapshots={[...remoteEvidence,...localEvidence]} currentCommandSequence={patchGetter.current()?.commandSequence}/>
      {mode !== 'replay' && <>
        <p className="tracking-readout" aria-label="شواهد ردیابی" style={!trackingCurrent ? { color: '#89939f' } : undefined}>اعتبار فعلی: {trackingCurrent ? 'هندسهٔ تازه، نه اثبات رنگ' : 'UNKNOWN؛ هندسهٔ قبلی قابل استفاده نیست'} · کارت معتبر فعلی: {trackingCurrent ? tracking?.evidence.cardCount ?? 0 : 0} · آخرین نامزدهای مشاهده‌شده: {lastEvidence?.candidateCount ?? 'نامعلوم'} · آخرین کارت: {lastEvidence?.cardCount ?? 'نامعلوم'} · آخرین پارچه: {lastEvidence?.fabricCount ?? 'نامعلوم'} · آخرین نشانگر: {lastEvidence?.markerCandidates ?? 'نامعلوم'} · علت: {tracking?.nextAction ?? 'هنوز قاب تازه تحلیل نشده'} {tracking?.debug?.reason} · هویت فریم: {tracking ? `${tracking.frame.presentedFrames} / ${tracking.frame.mediaTime}` : 'ندارد'}{tracking?.debug?.rejections && ` · رد هندسه: ${Object.entries(tracking.debug.rejections).map(([reason, count]) => `${reason}: ${count}`).join('، ')}`}</p>
        <p className="tracking-readout" aria-label="ضربان پردازش">{!cameraActive ? 'دوربین بسته است' : tracking?.frame.timeSource === 'callbackClock' && receiptAge !== null && receiptAge <= 2500 ? 'پردازش فعال؛ ساعت مرورگر ثابت است، پیش‌نمایش ادامه دارد' : trackingCurrent && tracking?.status !== 'waiting' ? 'پردازش فعال؛ آخرین تحلیل پاسخ گرفت' : processingActive ? 'پردازش فعال؛ تحلیل کند است و هندسه هنوز نامعلوم است' : 'دوربین پخش می‌شود، پردازش منتظر'} · callback واقعی: {callbacks} · سن آخرین callback: {callbackAge === null ? 'هنوز دریافت نشده' : `${(callbackAge / 1000).toFixed(1)} ثانیه`} · تحلیل شروع‌شده: {tracking?.debug?.jobsStarted ?? 'نامعلوم'} · تحلیل تکمیل‌شده: {tracking?.debug?.jobsCompleted ?? completedReceipts.current} · سن آخرین تحلیل: {receiptAge === null ? 'هنوز پاسخی نرسیده' : `${(receiptAge / 1000).toFixed(1)} ثانیه`} · آخرین مدت تحلیل: {lastObservation.current?.value.processingMs ?? 'نامعلوم'} ms · وضوح تحلیل: {tracking?.debug?.analysisWidth ?? 'نامعلوم'} × {tracking?.debug?.analysisHeight ?? 'نامعلوم'} · بازیابی: {tracking?.debug?.reason ?? tracking?.status ?? 'waiting'} · timeout: {tracking?.debug?.timeouts ?? 0} · retry: {tracking?.debug?.retries ?? 0} · reset: {tracking?.debug?.resets ?? 0}</p>
        {tracking?.frame.timeSource === 'callbackClock' && <p className="warning">زمان ویدئوی گزارش‌شده پیش نمی‌رود؛ فقط پیش‌نمایش آزمایشی با callback تازه ادامه دارد. این زمان جایگزین، اثبات فریم تازه برای اندازه‌گیری یا کالیبراسیون نیست.</p>}
      </>}
      <aside className="live-diagnostics" aria-label="عیب‌یابی زنده"><div className="section-title"><strong>ردگیری نرم‌افزار</strong><button onClick={exportTrace}>دریافت ردگیری JSON</button></div><p>مرحله: {progress} · برداشت مرجع: {observations.length} · نمونه‌ها: {queue.length} · اندازه‌گیری پاسخ‌گرفته: {measurements.length}</p><p>فرمان نمایشگر: {patchGetter.current()?.commandSequence ?? 'ندارد'} · رندر: {patchGetter.current()?.rendered ? 'تأیید دریافت شد' : 'تأیید نشده'} · آخرین رویداد: {traceRows.at(-1)?.at ?? 'ندارد'}</p><p aria-label="ذخیرهٔ خودکار عیب‌یابی">ثبت خودکار روی لپ‌تاپ: {diagnostics.state === 'saved' ? 'ذخیره شد' : diagnostics.state === 'saving' ? 'در حال ذخیره' : diagnostics.state === 'retry' ? 'ذخیره هنوز تأیید نشده' : 'منتظر رویداد'} · رویداد ذخیره‌شده: {diagnostics.savedSequence} · شناسهٔ آزمایش: {diagnostics.diagnosticId ?? snapshot.diagnosticId as string ?? 'هنوز دریافت نشده'}</p><p className="hint">این ردگیری رفتار برنامه است، نه اثبات دقت رنگ؛ تصویر، پیکسل خام و اطلاعات ورود صادر نمی‌شود.</p><ol className="trace-timeline" dir="ltr">{traceRows.slice(-8).map(row => <li key={row.sequence}>{row.sequence}. {row.area}/{row.event} {JSON.stringify(row.details)}</li>)}</ol></aside>
      {mode !== 'replay' && <>
        <p role="status" aria-label="اقدام بعدی" className="quick-guide">{livePreview ? previewStatus : !cameraActive ? 'ابتدا بازکردن دوربین و دیدن کادر را بزنید؛ اندازه‌گیری هنوز شروع نشده است.' : busy ? progress : advanced ? nextAction?.text ?? 'چیدمان آماده است.' : mode === 'threeStage' && !neutralDone ? 'سه کارت تیره، میانی و روشن را جدا داخل قاب بگذارید؛ این فقط کنترل محدود است، نه کالیبراسیون کامل.' : mode === 'threeStage' && actualReference?.validity !== 'verified' ? 'کنترل محدود کافی نیست؛ برای کالیبراسیون کامل مرجع رنگی با مقادیر معتبر نیاز است. مرجع را در تنظیمات کامل وارد کنید.' : mode === 'cameraMatch' && !neutralDone ? 'برای پیش‌نمایش، نمایش زندهٔ کالیته را بزنید؛ کارت‌ها اختیاری‌اند. برای تطبیق دقیق آزمایشی، سه کارت را جدا داخل قاب بگذارید.' : mode === 'cameraMatch' && neutralDone && !scene ? 'پارچه و نمایشگر را کنار هم داخل قاب بگذارید؛ برای تطبیق دقیق آزمایشی شروع بررسی همین قاب را بزنید.' : guidedSceneAction(scene, mode, Boolean(actualReference))}</p>
        <p className="hint">{mode === 'cameraMatch' ? 'گوشی A در هر سمت کالیته می‌تواند باشد. پیش‌نمایش بدون کارت هم شروع می‌شود؛ هم‌ترازی فقط با هندسهٔ معلوم صفحه انجام می‌شود. کارت‌های نامعلوم استاندارد ۱۸٪ فرض نمی‌شوند.' : 'گوشی A و پارچهٔ صاف کنار هم و کارت یا شاهد پایین قاب باشد. تمام صفحه و نوار سیاه‌وسفید A کامل و مستقیم دیده شود. ناحیه‌ها خودکار انتخاب می‌شوند؛ عکس‌گرفتن یا انتخاب دستی لازم نیست.'}</p>
        {tracking && <p role="status" aria-label="پایداری ردیابی">{trackingCurrent && tracking.geometryStable ? 'سه تشخیص پایدار دریافت شد؛ شروع فقط با دکمهٔ شماست.' : 'در انتظار سه تشخیص پایدار؛ ردیابی هندسه رنگ‌سنجی نیست.'} {tracking.nextAction}</p>}
        {mode === 'cameraMatch' && <p className="warning">قابلیت آزمایشی: فقط شباهت رنگ در همین دوربین؛ بررسی سه کارت، رنگ کاتالوگ معتبر یا کالیبراسیون کامل ایجاد نمی‌کند.</p>}
        {neutralReport && <p className="hint">بررسی واقعی کانال‌ها و کلیپ انجام شد. مقادیر فیزیکی کارت‌ها نامعلوم‌اند؛ تنظیم سخت‌افزار دوربین اعمال یا اثبات نشده است.</p>}
        <label className="check"><input type="checkbox" disabled={busy} checked={alignmentChecked} onChange={e => setAlignmentChecked(e.target.checked)} />چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم</label>
        {mode === 'cameraMatch' && <p className="hint">تطبیق دقیق آزمایشی، جدا از پیش‌نمایش زنده: قاب ثابت و برداشت‌های محدود، بدون تضمین تطبیق فیزیکی.</p>}
        <div className="toolbar"><button className="primary" disabled={busy || startBlocked || livePreview} onClick={() => void runAutomatic()}>{mode === 'cameraMatch' ? 'تطبیق دقیق آزمایشی' : 'شروع بررسی همین قاب'}</button><button disabled={busy || livePreview || (snapshot.paused && !alignmentChecked)} onClick={() => void detectArrangement()}>تشخیص خودکار چیدمان</button>{mode === 'cameraMatch' && !neutralDone && !advanced && <button disabled={busy || livePreview} onClick={skipCards}>ادامه بدون کارت، آزمایشی</button>}<button disabled={!busy} onClick={() => stopAutomation()}>توقف اجرای خودکار</button><button disabled={livePreview} onClick={() => setAdvanced(value => !value)}>{advanced ? 'بازگشت به نمای زنده' : 'نمایش تنظیمات کامل'}</button></div>
        <p className="hint">انتخاب ماشین، تأیید انسان یا صحت فیزیکی نیست. پس از قطع اتصال یا تغییر چیدمان، شروع مجدد فقط با اقدام شما انجام می‌شود.</p>
      </>}
      <div hidden={!advanced && mode !== 'replay'}>
      <p className="quick-guide">{mode === 'replay' ? 'بازپخش: تصویر اصلی را با رضایت ارسال کنید، ناحیه‌ها را رسم و تأیید کنید، سپس از بخش پارچه استخراج و گزارش بگیرید. این مسیر کالیبراسیون زنده نیست.' : 'گوشی B دوربین است؛ این صفحه را روی B باز کنید، دوربین را فعال کنید و پس از تغییر دوربین دوباره شاهد را بررسی و ادامه را تأیید کنید. گوشی A نمایشگر رنگ است؛ QR اتصال را روی A باز کنید. دوربین B باید کارت واقعی، شاهد خنثی، پارچه و در مسیر سه‌مرحله‌ای صفحهٔ A را ببیند.'}</p>
      <p className="hint">ROI یعنی ناحیهٔ انتخاب‌شده در تصویر. با مستطیل یا چندضلعی ناحیه رسم کنید؛ برچسب، چین و بازتاب را با قلم حذف کنار بگذارید و هندسه را تأیید کنید. برای نشانگر نوار سیاه‌وسفید A از ابزار «نشانگر» استفاده کنید.</p>
      {mode !== 'replay' && <button disabled={busy} onClick={() => void action(async () => { if (!navigator.mediaDevices?.enumerateDevices) throw new Error('فهرست دوربین به HTTPS یا localhost نیاز دارد.'); setDevices((await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')); })}>فهرست دوربین‌ها</button>}
      {mode === 'threeStage' && <div className="toolbar"><button disabled={busy || snapshot.paused} onClick={() => { if (!send('display.patch.set', { profileVersion: snapshot.profileVersion, patchId: crypto.randomUUID(), displayDriveRgb: [0.5, 0.5, 0.5], layout: 'single', sampleIds: [] })) setError('اتصال نمایشگر برای راه‌اندازی در دسترس نیست.'); }}>نمایش پچ راه‌اندازی برای تعیین ROI</button><span className="hint">فقط راه‌اندازی؛ نه کالیبراسیون و نه اثبات کیفیت</span></div>}
      {mode !== 'replay' ? <><div className="field-grid"><label>دوربین ثابت<select value={deviceId} onChange={e => { setDeviceId(e.target.value); pause('camera_selection_changed'); }}><option value="">دوربین پشت (بدون جایگزینی خودکار)</option>{devices.map(d => <option value={d.deviceId} key={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}</select></label><label>فضای canvas درخواست‌شده<select value={colorSpace} onChange={e => { setColorSpace(e.target.value as typeof colorSpace); pause('canvas_color_space_changed'); send('profile.invalidate', { reason: 'canvas_color_space_changed' }); setObservations([]); }}><option value="srgb">sRGB float</option><option value="display-p3">Display P3 float</option></select></label></div><button disabled={busy} onClick={() => void startCamera()}>فعال‌کردن دوربین B</button><p className="warning">قفل دستی واقعی: نامعلوم، حتی اگر applyConstraints موفق شود. برداشت از canvas ویدئو است، نه RAW؛ نبود float یا فریم تازه باعث توقف می‌شود.</p></> : <><label className="check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />با ارسال کامل تصویر اصلی به سرور محلی موافقم</label><label className="check"><input type="checkbox" checked={retention} onChange={e => setRetention(e.target.checked)} />نگهداری اصل تصویر تا حذف جلسه (پیش‌فرض خاموش)</label><label>تصویر اصلی برای بازپخش<input type="file" accept="image/jpeg,image/png,image/webp,image/tiff" disabled={!consent || busy} onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file); }} /></label>{image && <p>منبع: {image.sourceColorSpace}. پیش‌نمایش canonical sRGB؛ ICC اصلی فقط روی سرور یک‌بار اعمال شده و دوباره اعمال نمی‌شود. بازپخش همیشه آزمایشی است.</p>}</>}
      {mode !== 'replay' && advanced && <><div className="toolbar">{[['display', 'نمایشگر A'], ['witness', 'شاهد خنثی'], ['card', 'کارت مرجع'], ['fabric', 'پارچه']].map(([role, label]) => <button key={role} aria-pressed={drawRole === role} onClick={() => assignRole(role)}>{label}: رسم مستطیل</button>)}</div><button disabled={busy || !cameraActive || !fabricRoi} onClick={() => void suggestSamples()}>پیشنهاد خودکار نوارها از دوربین زنده</button>{suggestedIds.length > 0 && <button onClick={() => { geometryChanged(); setRegions(rows => rows.map(r => suggestedIds.includes(r.id) ? { ...r, operatorConfirmed: true } : r)); setSuggestedIds([]); }}>تأیید ناحیه‌های پیشنهادی</button>}</>}
      </div>
      {mode !== 'replay' && <details hidden={!advanced}><summary>گزارش کنترل‌ها و درخواست دستی</summary><p>supportedConstraints، capabilities، requested و getSettings جدا ثبت می‌شوند؛ تنظیم گزارش‌شده اثبات قفل firmware نیست. sharpness هنوز ارزیابی نشده است.</p><pre dir="ltr">{JSON.stringify(cameraReport, null, 2)}</pre><label>قیود دستی JSON<textarea dir="ltr" value={controlJson} onChange={e => setControlJson(e.target.value)} placeholder='{"exposureMode":"manual"}' /></label><button disabled={busy || !cameraActive} onClick={() => void action(async () => { const values = JSON.parse(controlJson); await cameraRef.current!.controls(values); setObservations([]); send('profile.invalidate', { reason: 'camera_controls_changed' }); const report = cameraRef.current!.report(); setCameraReport(report); send('capabilities.report', report); })}>درخواست کنترل و ابطال پروفایل</button></details>}
    </section>
    {mode !== 'replay' && queue.length > 0 && <section className="panel" aria-label="صف نمونه‌های خودکار"><h2>صف نمونه‌ها</h2><p>کل: {queue.length} · در صف: {queue.filter(r => r.status === 'queued').length} · برداشت‌شده: {queue.filter(r => r.measurement).length} · تطبیق تکمیل‌شده: {queue.filter(r => r.status === 'complete').length} · مردود: {queue.filter(r => r.status === 'rejected').length}</p><ol>{queue.map(row => <li key={row.regionId}>{row.label}: {({ queued: 'در صف', capturing: 'برداشت فریم تازه', measured: 'اندازه‌گیری پاسخ گرفت', matching: 'تطبیق زنده', complete: 'تطبیق طبق سرور تکمیل شد', stopped: 'تطبیق بدون همگرایی متوقف شد', rejected: 'مردود؛ گزارش حفظ شد' } as const)[row.status]}{row.measurement && <span> · کاتالوگ: {String(row.measurement.catalogStatus ?? 'نامعلوم')} · {String(row.measurement.catalogHexSrgb ?? '')}</span>}</li>)}</ol></section>}
    <details open={advanced} onToggle={e => setAdvanced(e.currentTarget.open)}><summary>کنترل‌های پیشرفته</summary><div hidden={!advanced}>
    <section className="panel" id="lab-reference"><h2>۰۱ / مرجع فیزیکی و مدل دوربین</h2><p className="quick-guide">مقادیر واقعی کارت را از فایل JSON/CSV یا ورودی دستی ثبت کنید؛ هر پچ کارت را به ناحیهٔ مستقل تصویر وصل کنید، برداشت هم‌زمان بگیرید و سپس مدل دوربین را برازش کنید. train دادهٔ برازش و holdout پچ مستقل برای آزمون است؛ مقادیر نامعلوم را حدس نزنید.</p><p>کارت ناشناخته و اطلاعات نامعلوم فقط مسیر اکتشافی دارند. مرجع verified باید از منبع واقعی باشد؛ نمایش روی صفحه جای کارت فیزیکی نیست.</p>
      <div className="field-grid">{[['id', 'شناسهٔ مرجع'], ['label', 'نام مرجع'], ['source', 'منبع مقادیر مرجع'], ['version', 'نسخهٔ مرجع']].map(([key, label]) => <label key={key}>{label}<input value={meta[key as keyof ReferenceMeta]} onChange={e => setMeta(m => ({ ...m, [key]: e.target.value }))} /></label>)}<label>نوع مقادیر<select value={meta.valueType} onChange={e => setMeta(m => ({ ...m, valueType: e.target.value as ReferenceMeta['valueType'] }))}><option>Lab</option><option>XYZ</option></select></label><label>سفید مرجع<select value={meta.referenceWhite} onChange={e => setMeta(m => ({ ...m, referenceWhite: e.target.value as ReferenceMeta['referenceWhite'] }))}><option>D50</option><option>D65</option></select></label><label>Observer<select value={meta.observer} onChange={e => setMeta(m => ({ ...m, observer: e.target.value as '2' | '10' }))}><option value="2">2°</option><option value="10">10° (ممکن است پشتیبانی نشود)</option></select></label><label>اعتبار منبع<select value={meta.validity} onChange={e => setMeta(m => ({ ...m, validity: e.target.value as ReferenceMeta['validity'] }))}><option value="unverified">تأیید نشده</option><option value="verified">تأییدشده توسط اپراتور و منبع</option></select></label></div>
      <label>ورودی مرجع JSON یا CSV<textarea dir="ltr" value={referenceText} onChange={e => setReferenceText(e.target.value)} placeholder="id,v1,v2,v3,split,neutral" /></label><label>فایل مرجع JSON / CSV<input type="file" accept=".json,.csv,text/csv,application/json" onChange={e => { const file = e.target.files?.[0]; if (file) void file.text().then(setReferenceText); }} /></label>
      <details><summary>افزودن مقادیر دستی پچ</summary><div className="field-grid">{[['id', 'شناسه پچ'], ['a', 'مقدار ۱'], ['b', 'مقدار ۲'], ['c', 'مقدار ۳']].map(([key, label]) => <label key={key}>{label}<input value={manual[key as 'id' | 'a' | 'b' | 'c']} onChange={e => setManual(m => ({ ...m, [key]: e.target.value }))} /></label>)}<label>بخش داده<select value={manual.split} onChange={e => setManual(m => ({ ...m, split: e.target.value }))}><option value="train">train</option><option value="holdout">holdout</option></select></label><label className="check"><input type="checkbox" checked={manual.neutral} onChange={e => setManual(m => ({ ...m, neutral: e.target.checked }))} />پچ خنثی</label></div><button onClick={addManual}>افزودن پچ به ورودی مرجع</button></details>
      <div className="toolbar"><button disabled={busy} onClick={() => void applyReference()}>ثبت مرجع واقعی</button><button disabled={busy} onClick={() => void action(async () => { setResult(await api.post('reference', { exploratory: true })); setExploratory(true); setReference(null); setObservations([]); })}>ثبت مسیر اکتشافی بدون مرجع</button></div>
      {reference && <><h3>اتصال پچ‌های کارت به ROI فیزیکی</h3><div className="field-grid">{reference.patches.map(p => <div key={p.id}>{selector(`${p.id} · ${p.split}`, bindings[p.id] ?? '', value => setBindings(b => ({ ...b, [p.id]: value })))}</div>)}</div><button disabled={busy || !cameraActive} onClick={() => void captureReference()}>برداشت هم‌زمان پچ‌های مرجع، ۱۰ فریم</button></>}
      <p>پچ‌های برداشت‌شده: {observations.length} · train و holdout باید فیزیکی، مستقل و بدون اشتراک باشند. تغییر نگاشت یا هندسه نیازمند برداشت مجدد است.</p><button disabled={busy || (!exploratory && (!observations.length || capturedReferenceKey !== referenceCaptureKey(regions, bindings)))} onClick={() => void action(async () => { if (!exploratory && capturedReferenceKey !== referenceCaptureKey(regions, bindings)) throw new Error('نگاشت مرجع عوض شده؛ دوباره برداشت کنید.'); setResult(await api.post('camera-profile', { observations: exploratory ? [] : observations, fingerprint: cameraRef.current?.fingerprint() ?? 'exploratory-no-camera' })); })}>برازش دوربین با برداشت‌های ثبت‌شده</button>
    </section>
    {mode === 'threeStage' ? <section className="panel" id="lab-display"><h2>۰۲ / جبران نمایشگر با شاهد</h2><p className="quick-guide">ابتدا پچ راه‌اندازی A را نمایش دهید و ناحیهٔ رنگ و نشانگر را در تصویر B مشخص کنید. چهار ناحیهٔ جدا برای نمایشگر، شاهد خنثی، کارت و پارچه انتخاب کنید؛ پچ متناظر کارت را تعیین و شبکه را اجرا کنید. شاهد خنثی برای تشخیص تغییر نور است، نه جایگزین مرجع رنگ.</p><p>مدل پاسخ دوربین‌مرجع، نه ICC و نه کالیبراسیون مطلق. loop فقط با فرمان تازه، ACK رندر، نشانگر فیزیکی و شاهد ادامه می‌یابد. ۸ train و ۳ holdout، همراه baseline و دو بررسی آلودگی نور.</p><div className="field-grid">{selector('ROI رنگ نمایشگر', displayRoi, setDisplayRoi)}{selector('ROI شاهد خنثی', witnessRoi, setWitnessRoi)}{selector('ROI کارت هم‌زمان', cardRoi, setCardRoi)}{selector('ROI پارچه برای آلودگی نور', fabricRoi, setFabricRoi)}<label>پچ مرجع کارت<select value={cardPatchId} onChange={e => setCardPatchId(e.target.value)}><option value="">انتخاب نشده</option>{reference?.patches.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}</select></label></div><button disabled={busy || snapshot.paused || !cameraActive || !snapshot.cameraProfile || !marker || !cardRoi || !fabricRoi || !cardPatchId} onClick={() => void action(async () => { const abort = controller(); setResult(await runGrid({ request: requestPatch, capture: loopCapture, post: (r, b) => api.post(r, b), fingerprint: cameraRef.current!.fingerprint(), cardPatchId, signal: abort.signal, progress: setProgress })); })}>اجرای شبکهٔ فیزیکی و برازش نمایشگر</button></section> : <section className="panel" id="lab-display"><h2>۰۲ / نمایشگر عمداً حذف شده</h2><p>{mode === 'catalogOnly' ? 'این جلسه صریحاً فقط کاتالوگ است؛ ادعای تطبیق نمایشگر ندارد.' : 'بازپخش تصویر جای آزمایش سه‌مرحله‌ای زنده نیست و خروجی آن اکتشافی است.'}</p></section>}
    <section className="panel" id="lab-fabric"><h2>۰۳ / پارچه، نتیجه و تطبیق</h2><p className="quick-guide">ناحیه‌های پارچه را با نام و ترتیب مشخص تأیید و استخراج کنید. در مسیر سه‌مرحله‌ای، اندازه‌گیری هدف را انتخاب کنید و ناحیهٔ پارچه برای آلودگی نور را روی همان نمونه قرار دهید؛ سپس تطبیق را اجرا کنید. جدول، اصلاح دستی، نمایش گروهی و گزارش در همین مسیر باقی می‌مانند.</p><p>نمونه‌ها با ترتیب اپراتور برداشت می‌شوند؛ نوارهای هم‌رنگ خودکار ادغام نمی‌شوند. رنگ کاتالوگ مستقل از drive نمایشگر است. نتیجهٔ مردود همراه گزارش باقی می‌ماند.</p><div className="toolbar"><button disabled={busy || (mode !== 'replay' && snapshot.paused)} onClick={() => void measure()}>استخراج ناحیه‌های پارچه</button><button disabled={busy || !regions.length || (mode !== 'replay' && snapshot.paused)} onClick={() => void action(async () => { const region = regions[0]; if (mode === 'replay') { if (!image) throw new Error('تصویر بارگذاری نشده است.'); const response = await api.post<{ regions: Region[] }>(`images/${image.captureId}/suggest-bands`, { polygon: normalizedRegion(region, dimensions.width, dimensions.height).polygon, orientation: 'horizontal' }); setRegions(response.regions.map(r => ({ ...r, polygon: r.polygon.map(([x, y]) => [x * dimensions.width, y * dimensions.height]), exclusions: r.exclusions.map(p => p.map(([x, y]) => [x * dimensions.width, y * dimensions.height])), operatorConfirmed: false }))); } else { const [frames] = await capture([region], controller().signal); setResult(await api.post('captures/analyze', { frames, region: normalizedRegion(region, dimensions.width, dimensions.height) })); } })}>{mode === 'replay' ? 'پیشنهاد نوارها برای بازبینی' : 'تحلیل کیفیت ناحیهٔ اول'}</button></div>
      {mode !== 'replay' && <><p className="warning">برای خروجی مرجع‌دار، هر نمونه همراه شاهد خنثی و کارت در همان فریم‌ها برداشت می‌شود. بدون این اتصال، برآورد محدود/اکتشافی است و تأیید نمی‌شود. در catalogOnly شاهد خنثی باید با پچ خنثی مرجع انتخاب‌شده متناظر باشد.</p>{mode === 'catalogOnly' && <div className="field-grid">{selector('ROI شاهد خنثی برداشت', witnessRoi, setWitnessRoi)}{selector('ROI کارت برداشت', cardRoi, setCardRoi)}<label>پچ مرجع برای شاهد برداشت<select value={cardPatchId} onChange={e => setCardPatchId(e.target.value)}><option value="">انتخاب نشده</option>{reference?.patches.filter(p => p.neutral).map(p => <option value={p.id} key={p.id}>{p.id}</option>)}</select></label></div>}</>}
      {mode === 'threeStage' && <><label>اندازه‌گیری برای تطبیق<select value={matchId} onChange={e => setMatchId(e.target.value)}><option value="">انتخاب نشده</option>{measurements.map(m => <option key={measurementId(m)} value={measurementId(m)}>{measurementId(m)}</option>)}</select></label><button disabled={busy || snapshot.paused || !matchId || !snapshot.displayProfile || !marker || !cardRoi || !witnessRoi || !fabricRoi || !cardPatchId} onClick={() => void action(async () => { const abort = controller(); const match = await runMatch(matchId, { request: requestPatch, capture: loopCapture, post: (r, b) => api.post(r, b), signal: abort.signal, progress: setProgress, cardPatchId }); setMatches(m => [...m, { ...match, measurementId: matchId }]); setResult(match); })}>تطبیق فیزیکی محدود، حداکثر ۴۰ ارزیابی</button><p>نرسیدن به هدف، اثبات خارج‌بودن از گاموت نیست. مشاهدهٔ تک‌پچ اعتبار نمایش گروهی ایجاد نمی‌کند.</p></>}
      <div className="table-scroll"><table><caption>جدول نتایج واقعی سرور</caption><thead><tr><th>شناسه</th><th>نمونه</th><th>کیفیت برداشت</th><th>وضعیت کاتالوگ</th><th>تطبیق نمایشگر</th><th>رنگ کاتالوگ</th><th>تأیید</th><th>اعتبار مستقل</th></tr></thead><tbody>{measurements.map(m => <tr key={measurementId(m)}><td dir="ltr">{measurementId(m)}</td><td>{String((m.region as Region | undefined)?.label ?? m.sampleId ?? '')}</td><td>{String(m.captureQuality ?? (m.quality as { status?: string } | undefined)?.status ?? 'نامعلوم')}</td><td>{String(m.catalogStatus ?? 'نامعلوم')}</td><td>{String(m.displayStatus ?? 'notMatched')}</td><td dir="ltr">{String(m.catalogHexSrgb ?? (m.catalogColor as { hex?: string } | undefined)?.hex ?? '—')}</td><td>{m.approved === true ? 'تأیید سرور' : 'تأیید نشده'}</td><td>{String(m.independentValidationStatus ?? 'notTested')}</td></tr>)}</tbody></table></div>
      <details open><summary>اصلاح دستی، نسخهٔ جدید با منشأ مستقل</summary><p>اصلاح دستی، اندازه‌گیری فیزیکی یا تأیید کاتالوگ نیست؛ مقدار اصلی بازنویسی نمی‌شود.</p><label>اندازه‌گیری پایهٔ اصلاح دستی<select value={overrideId} onChange={e => setOverrideId(e.target.value)}><option value="">انتخاب نشده</option>{measurements.map(m => <option key={measurementId(m)} value={measurementId(m)}>{measurementId(m)}</option>)}</select></label><label>HEX sRGB دستی<input dir="ltr" value={overrideHex} onChange={e => setOverrideHex(e.target.value)} placeholder="#RRGGBB" /></label><label>دلیل اصلاح دستی<input value={overrideReason} onChange={e => setOverrideReason(e.target.value)} /></label><button disabled={busy || !overrideId || !/^#[0-9a-fA-F]{6}$/.test(overrideHex) || !overrideReason.trim()} onClick={() => void action(async () => { const version = await api.post<Record<string, unknown>>(`measurements/${encodeURIComponent(overrideId)}/override`, { catalogHexSrgb: overrideHex, reason: overrideReason.trim() }); setMeasurements(m => [...m, version]); setResult(version); })}>ثبت نسخهٔ جدید اصلاح دستی</button></details>
      <button onClick={() => { const text = ['id\tcaptureQuality\tcatalogStatus\tdisplayStatus\tcatalogHexSrgb\tapproved\tindependentValidationStatus', ...measurements.map(m => `${measurementId(m)}\t${m.captureQuality ?? 'unknown'}\t${m.catalogStatus ?? 'unknown'}\t${m.displayStatus ?? 'notMatched'}\t${m.catalogHexSrgb ?? ''}\t${m.approved === true}\t${m.independentValidationStatus ?? 'notTested'}`)].join('\n'); setTableCopy(text); void navigator.clipboard?.writeText(text).catch(() => {}); }}>کپی جدول</button>{tableCopy && <textarea aria-label="جدول قابل کپی" dir="ltr" readOnly value={tableCopy} />}
      {matches.length > 0 && <details><summary>تاریخچهٔ تطبیق، بدون تغییر رنگ کاتالوگ</summary><pre dir="ltr">{JSON.stringify(matches, null, 2)}</pre></details>}
      {mode === 'threeStage' && <div className="group-controls"><p>نمایش گروهی آزمایشی با کارت‌های حداقل ۱۸۰ پیکسل؛ گروه‌ها طبق ابعاد گزارش‌شدهٔ A صفحه‌بندی می‌شوند. پیکسل CSS اندازهٔ فیزیکی را تضمین نمی‌کند و اعتبار گروهی هنوز تأیید نشده است.</p><div className="toolbar"><button disabled={groupPage === 0} onClick={() => setGroupPage(p => p - 1)}>گروه قبلی</button><span>گروه {groupPage + 1} از {Math.max(1, Math.ceil(groupCards.length / groupSize))}</span><button disabled={(groupPage + 1) * groupSize >= groupCards.length} onClick={() => setGroupPage(p => p + 1)}>گروه بعدی</button><button disabled={busy || snapshot.paused || groupCards.length === 0} onClick={() => { const patches = groupCards.slice(groupPage * groupSize, groupPage * groupSize + groupSize).map(m => ({ sampleId: measurementId(m), drive: m.displayDriveRgb })); if (!send('display.patch.set', { profileVersion: snapshot.profileVersion, patchId: crypto.randomUUID(), displayDriveRgb: [0, 0, 0], layout: 'group', sampleIds: patches.map(p => p.sampleId), patches })) setError('اتصال برای نمایش گروهی موجود نیست.'); }}>نمایش گروهی رنگ‌های تطبیق‌شده، تأییدنشده</button></div></div>}
    </section>
    <section className="panel" id="lab-report"><h2>گزارش، شرایط و حذف داده</h2><label>نوع خروجی<select value={exportKind} onChange={e => setExportKind(e.target.value as typeof exportKind)}><option value="experimental">آزمایشی، همراه شکست‌ها</option><option value="approved">تأییدشده، فقط اگر سرور اجازه دهد</option></select></label><div className="toolbar"><button disabled={busy} onClick={() => void exportFile('json')}>دریافت JSON</button><button disabled={busy} onClick={() => void exportFile('csv')}>دریافت CSV</button></div><p>انتخاب approved به معنی تأیید نیست؛ نمونه‌های نامعتبر رنگ کاتالوگ تأییدشده ندارند ولی گزارش شکست حذف نمی‌شود.</p>
      <details><summary>ثبت اعتبارسنجی یا اندازه‌گیری ابزار مستقل</summary><label>گزارش اعتبارسنجی JSON<textarea dir="ltr" value={validationText} onChange={e => setValidationText(e.target.value)} /></label><button disabled={busy} onClick={() => void action(async () => { setResult(await api.post('validations', JSON.parse(validationText))); })}>ارسال گزارش واقعی بدون بازنویسی اندازه‌گیری</button><p>ورودی دستی اثبات اتصال ابزار نیست؛ منبع، شرایط، هندسه، زمان و تأیید اپراتور باید در گزارش باشد.</p></details>
      <details><summary>به‌روزرسانی شرایط جلسه</summary><label>شرایط JSON<textarea dir="ltr" value={conditionsJson} onChange={e => setConditionsJson(e.target.value)} placeholder={JSON.stringify(snapshot.conditions ?? {}, null, 2)} /></label><button disabled={busy} onClick={() => void action(async () => { pause('conditions_changed'); setResult(await api.conditions(JSON.parse(conditionsJson))); setObservations([]); })}>ثبت شرایط و ابطال وابستگی‌های مربوط</button></details>
      <button className="danger" disabled={busy} onClick={() => { if (window.confirm('پروفایل‌ها، اصل تصاویر و داده‌های این جلسه حذف شوند؟')) void action(async () => { pause('session_deleted'); await api.delete(); activeAbort.current?.abort(); cameraRef.current?.stop(); pipelineRef.current?.stop(); setMeasurements([]); setRegions([]); setImage(null); setPreview(''); setResult({ deleted: true }); onDeleted?.(); }, false); }}>حذف کامل جلسه و تصاویر</button>
    </section>
    </div></details>
    {result && <details className="panel" open><summary>آخرین پاسخ واقعی سرور / برداشت</summary><pre dir="ltr">{JSON.stringify(result, null, 2)}</pre></details>}{mode === 'replay' && error && <p className="error" role="alert">{error}</p>}
  </div>;
}
