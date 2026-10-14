import type { Rect } from './marker';
import { bounds, type Point, type Region } from './sampling';
import type { LivePreviewBand, Mode } from './session';
import type { ScreenAppearanceBand,ScreenBandEvidence } from './previewSampling';
import type { TrackingRequest, TrackingResponse } from './tracking.worker';

export type TrackingPhase = 'cards' | 'scene';
export type TrackingFrame = { presentedFrames: number; mediaTime: number; width: number; height: number; timeSource?: 'videoMediaTime' | 'callbackClock'; reportedMediaTime?: number };
export type TrackingEvidence = { candidateCount: number; cardCount: number; fabricCount: number; neutralCount: number; markerCandidates: number; motionSamples: number; markerSequence?: number };
export type TrackingDiagnostics = { reason?: string; matchingTriplets?: number; markerSentinels?:number;markerRejections?:Record<string,number>; rejections?: Record<string, number>; analysisWidth?: number; analysisHeight?: number; analysisLongEdge?: number; frameCallbacks?: number; jobsStarted?: number; jobsCompleted?: number; timeouts?: number; resets?: number; retries?: number; attempt?: number; processingMs?: number; lastFrameAt?: number; lastCompletedAt?: number };
export type LiveTracking = LivePreviewTracking & { phase: TrackingPhase; status: 'ready' | 'needsFraming' | 'ambiguous' | 'waiting' | 'error'; nextAction: string; regions: Region[]; marker: Rect | null; evidence: TrackingEvidence; frame: TrackingFrame; processingMs: number; geometryStable: boolean; moving: boolean; pixelMoving?: boolean; surfaceChanged?: boolean; fresh?: boolean; expectedSequence?: number; candidateRegions?: Region[]; debug?: TrackingDiagnostics };
export type DisplayBandContext = {commandSequence:number;bands:LivePreviewBand[]};
export type PreviewRejectionReason='markerMissing'|'markerMismatch'|'screenApertureMissing'|'screenGeometryUncertain'|'cameraMoving'|'bandLayoutMismatch'|'commandNotRendered'|'geometryUnstable'|import('./previewSampling').ScreenSampleReason;
export type LivePreviewTracking = {previewBands?:{id:string;previewRgb:[number,number,number];top:number;bottom:number}[];previewScreenRoi?:Point[];previewMarkerCells?:number[][];previewSamplingEvidence?:ScreenBandEvidence[];previewFeedbackRejectionReasons?:PreviewRejectionReason[];previewFeedback?:{markerSequence:number;markerPixels:number[][];screenRoi:Point[];screenAppearanceBands:ScreenAppearanceBand[]};previewMapping?:'screenAligned'|'orderedPreview';previewWarnings?:string[];neutralCardRegions?:{role:'dark'|'middle'|'light';region:Region}[];relativeGeometryStable?:boolean;responseWitnessEvidence?:{candidateCount:number;eligibleCount:number;ordering:{index:number;distance:number}[];rejections:Record<string,number>}};
export type TrackingDetection = Omit<LiveTracking, 'geometryStable' | 'moving'> & LivePreviewTracking & { pixelMoving: boolean };
export type TrackingState = { tracking: LiveTracking; stableDetections: number };

export function computeTracking(previous: TrackingState | null, current: TrackingDetection): TrackingState {
  const old = previous?.tracking;
  if (old && (current.frame.presentedFrames <= old.frame.presentedFrames || current.frame.mediaTime <= old.frame.mediaTime)) return previous!;
  const ready = current.status === 'ready' && (current.phase === 'cards' ? current.regions.length === 3 : current.regions.length >= 2 && current.marker !== null);
  let same = Boolean(old && old.phase === current.phase && old.status === 'ready' && old.frame.width === current.frame.width && old.frame.height === current.frame.height && old.regions.length === current.regions.length);
  if (same) same = current.regions.every(region => {
    const prior = old!.regions.find(r => r.id === region.id);
    if (!prior || region.polygon.length !== prior.polygon.length) return false;
    const a = bounds(prior.polygon), b = bounds(region.polygon);
    const tolerance = Math.max(2, Math.min(a.width, a.height) * 0.04);
    return Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2) <= tolerance
      && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance
      && region.polygon.every((p, i) => Math.hypot(p[0] - prior.polygon[i][0], p[1] - prior.polygon[i][1]) <= tolerance);
  });
  if (same && (old!.marker || current.marker)) {
    const a = old!.marker, b = current.marker;
    const tolerance = Math.max(2, (a?.width ?? 0) * 0.02);
    same = Boolean(a && b && Math.hypot(a.x - b.x, a.y - b.y) <= tolerance && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance);
  }
  const moving = current.pixelMoving || Boolean(current.surfaceChanged) || Boolean(old?.phase === current.phase && old.status === 'ready' && (!ready || !same));
  const stableDetections = ready && !moving ? (same ? (previous?.stableDetections ?? 0) + 1 : 1) : 0;
  return { stableDetections, tracking: { ...current, geometryStable: stableDetections >= 3, moving } };
}

export interface TrackingWorker {
  onmessage: ((event: MessageEvent<TrackingResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: TrackingRequest, transfer: Transferable[]): void;
  terminate(): void;
}
export type LiveTrackerOptions = { phase: TrackingPhase; expectedSequence?: number; displayBands?:DisplayBandContext;mode?: Mode; purpose?:'response'; onError?: (error: Error) => void; onFrame?: (frame: TrackingFrame) => void; signal?: AbortSignal; workerFactory?: () => TrackingWorker; readFrame?: (video: HTMLVideoElement, width: number, height: number) => TrackingRequest['image'] };

export class LiveTracker {
  private options: LiveTrackerOptions;
  private worker: TrackingWorker | null = null;
  private running = false;
  private handle: number | null = null;
  private pending: TrackingRequest | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private starvation: ReturnType<typeof setTimeout> | null = null;
  private slowTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingSlow = false;
  private longEdge: number;
  private workerErrors = 0;
  private counters = { frameCallbacks: 0, jobsStarted: 0, jobsCompleted: 0, timeouts: 0, resets: 0, retries: 0 };
  private analysisWidth = 0;
  private analysisHeight = 0;
  private lastProcessingMs = 0;
  private lastFrameAt = 0;
  private lastCompletedAt = 0;
  private observed: TrackingFrame | null = null;
  private reportedMediaTime = -1;
  private generation = 0;
  private id = 0;
  private nextAt = -Infinity;
  private submittedAt = 0;
  private capturedClock = 0;
  private interval = 500;
  private lastPresented = -1;
  private accepted: TrackingFrame | null = null;
  private lastStatus: LiveTracking['status'] | null = null;
  private canvas: HTMLCanvasElement | null = null;

  constructor(private video: HTMLVideoElement, private onUpdate: (tracking: LiveTracking) => void, options: LiveTrackerOptions) { this.options = { ...options }; this.longEdge = options.phase === 'cards' ? 480 : 640; }

  start() {
    if (this.running || this.options.signal?.aborted) return;
    this.running = true;
    this.lastStatus = null;
    this.options.signal?.addEventListener('abort', this.aborted, { once: true });
    document.addEventListener('visibilitychange', this.visibility);
    this.publishUnavailable('waiting', 'منتظر فریم تازهٔ دوربین؛ کادر زنده را تنظیم کنید.');
    if (!document.hidden) this.schedule();
  }

  configure(options: Partial<Pick<LiveTrackerOptions, 'phase' | 'expectedSequence' | 'mode' | 'purpose' | 'displayBands'>>) {
    const detectionOptions={...options};delete detectionOptions.displayBands;
    const changed = Object.keys(detectionOptions).some(key => this.options[key as keyof typeof options] !== options[key as keyof typeof options]);
    const reset = (options.phase !== undefined && options.phase !== this.options.phase) || ('mode' in options && options.mode !== this.options.mode) || ('purpose' in options && options.purpose !== this.options.purpose);
    this.options = { ...this.options, ...options };
    if (!changed) return;
    this.generation++; this.nextAt = -Infinity;
    if (reset) { this.count('resets'); this.dispose(); this.accepted = null; this.longEdge = this.options.phase === 'cards' ? 480 : 640; }
    this.lastStatus = null;
    if (this.running) { this.publishUnavailable('waiting', 'منتظر تشخیص تازه؛ کادر قبلی معتبر نیست.'); this.schedule(); }
  }

  // The owner calls this only for an explicit new arrangement, before acquisition.
  resetBaseline() {
    this.generation++;
    this.count('resets');
    this.dispose();
    this.accepted = null;
    this.nextAt = -Infinity;
    this.lastStatus = null;
    if (this.running) {
      this.publishUnavailable('waiting', 'منتظر تشخیص تازه؛ کادر قبلی معتبر نیست.');
      this.schedule();
    }
  }

  stop() {
    this.running = false;
    this.generation++;
    document.removeEventListener('visibilitychange', this.visibility);
    this.options.signal?.removeEventListener('abort', this.aborted);
    this.dispose();
    this.canvas = null;
    this.accepted = null;
    this.lastPresented = -1;
    this.observed = null;
    this.reportedMediaTime = -1;
    this.nextAt = -Infinity; this.interval = 500;
    this.workerErrors = 0;
  }

  private aborted = () => this.stop();
  private visibility = () => {
    if (!this.running) return;
    this.generation++;
    this.count('resets');
    this.dispose();
    this.nextAt = -Infinity;
    this.publishUnavailable('waiting', document.hidden ? 'صفحه پنهان است؛ ردیابی موقتاً متوقف شد.' : 'منتظر تشخیص تازه؛ کادر قبلی معتبر نیست.');
    if (!document.hidden) this.schedule();
  };

  private dispose() {
    if (this.handle !== null) this.video.cancelVideoFrameCallback?.(this.handle);
    this.handle = null;
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null; this.pending = null;
    if (this.slowTimeout !== null) clearTimeout(this.slowTimeout);
    this.slowTimeout = null; this.pendingSlow = false;
    if (this.starvation !== null) clearTimeout(this.starvation);
    this.starvation = null;
    if (this.worker) {
      this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = null;
    }
  }

  private diagnostics(processingMs = this.lastProcessingMs): TrackingDiagnostics {
    return { ...this.counters, attempt: this.counters.jobsStarted, analysisWidth: this.analysisWidth, analysisHeight: this.analysisHeight, analysisLongEdge: Math.max(this.analysisWidth, this.analysisHeight), processingMs: Math.min(1_000_000, Math.max(0, processingMs)), lastFrameAt: this.lastFrameAt, lastCompletedAt: this.lastCompletedAt };
  }

  private publishUnavailable(status: 'waiting' | 'error', nextAction: string, reason?: string) {
    if (status === this.lastStatus && !reason) return;
    this.lastStatus = status;
    this.onUpdate({ phase: this.options.phase, status, nextAction, regions: [], candidateRegions: [], marker: null, expectedSequence: this.options.expectedSequence, frame: this.accepted ?? { presentedFrames: 0, mediaTime: 0, width: this.video.videoWidth, height: this.video.videoHeight }, processingMs: 0, geometryStable: false, moving: Boolean(this.accepted), pixelMoving: false, surfaceChanged: false, fresh: false, debug: { ...this.diagnostics(this.pending ? performance.now() - this.capturedClock : this.lastProcessingMs), reason }, evidence: { candidateCount: 0, cardCount: 0, fabricCount: 0, neutralCount: 0, markerCandidates: 0, motionSamples: 0 } });
  }

  private count(key: keyof typeof this.counters) { this.counters[key] = Math.min(1_000_000, this.counters[key] + 1); }

  private reduceResolution() {
    this.longEdge = this.longEdge > 480 ? 480 : this.longEdge > 320 ? 320 : 256;
  }

  private slowMessage() {
    return `پردازش تصویر کند؛ ردیابی ادامه دارد و با تصویر کوچک‌تر دوباره تلاش می‌شود.${this.longEdge <= 320 ? ' گوشی A را نزدیک‌تر بیاورید تا نشانگر واضح‌تر باشد.' : ''}`;
  }

  private recover(reason: string, reduce: boolean) {
    if (!this.running) return;
    if (reduce) this.reduceResolution();
    this.generation++; this.count('resets'); this.count('retries');
    this.dispose();
    this.nextAt = performance.now() + 500;
    this.publishUnavailable('waiting', this.slowMessage(), reason);
    this.schedule();
  }

  private workerFailure(error: Error) {
    if (!this.running) return;
    if (++this.workerErrors >= 3) { this.fail(new Error(`پردازش ردیابی پس از سه خطای پیاپی متوقف شد؛ گزارش خطا را دریافت کنید. ${error.message}`)); return; }
    this.generation++; this.count('resets'); this.count('retries');
    this.dispose(); this.nextAt = performance.now() + 500;
    this.publishUnavailable('waiting', 'خطای پردازش ردیابی؛ تلاش خودکار دوباره انجام می‌شود.', 'workerRetry');
    this.schedule();
  }

  private fail(error: unknown) {
    if (!this.running) return;
    const e = error instanceof Error ? error : new Error('Live tracking failed');
    this.publishUnavailable('error', e.message);
    this.stop();
    this.options.onError?.(e);
  }

  private schedule() {
    if (!this.running || document.hidden || this.handle !== null) return;
    if (!this.video.requestVideoFrameCallback) { this.fail(new Error('این مرورگر دریافت فریم تازه برای ردیابی را پشتیبانی نمی‌کند.')); return; }
    this.handle = this.video.requestVideoFrameCallback(this.onFrame);
  }

  private onFrame: VideoFrameRequestCallback = (now, metadata) => {
    this.handle = null;
    if (!this.running || document.hidden) return;
    this.count('frameCallbacks');
    try {
      const width = this.video.videoWidth, height = this.video.videoHeight;
      if (!width || !height || this.video.readyState < 2) { this.publishUnavailable('waiting', 'منتظر مجوز دوربین و آماده‌شدن تصویر زنده.'); return; }
      if (!Number.isSafeInteger(metadata.presentedFrames) || metadata.presentedFrames < 0 || !Number.isFinite(metadata.mediaTime) || metadata.mediaTime < 0 || metadata.presentedFrames <= (this.observed?.presentedFrames ?? -1)) return;
      const frozenClock = metadata.mediaTime <= this.reportedMediaTime;
      const frame: TrackingFrame = { presentedFrames: metadata.presentedFrames, mediaTime: frozenClock ? Math.max(performance.now() / 1000, (this.observed?.mediaTime ?? -1) + 0.000001) : metadata.mediaTime, width, height, timeSource: frozenClock ? 'callbackClock' : 'videoMediaTime', reportedMediaTime: metadata.mediaTime };
      this.reportedMediaTime = metadata.mediaTime;
      this.observed = frame; this.lastFrameAt = performance.now();
      this.options.onFrame?.(frame);
      if (!this.running || document.hidden || this.pending || now < this.nextAt) return;
      if (metadata.presentedFrames <= this.lastPresented) return;
      if (!this.worker) {
        this.worker = this.options.workerFactory?.() ?? new Worker(new URL('./tracking.worker.ts', import.meta.url), { type: 'module' });
        const worker = this.worker;
        this.worker.onmessage = event => { if (this.worker === worker) this.onMessage(event); };
        this.worker.onerror = () => { if (this.worker === worker) this.workerFailure(new Error('خطای worker ردیابی.')); };
        this.worker.onmessageerror = () => { if (this.worker === worker) this.workerFailure(new Error('پاسخ ردیابی خوانده نشد.')); };
      }
      const factor = Math.min(1, this.longEdge / Math.max(width, height));
      const w = Math.max(1, Math.floor(width * factor)), h = Math.max(1, Math.floor(height * factor));
      this.capturedClock = performance.now();
      let image: TrackingRequest['image'];
      if (this.options.readFrame) image = this.options.readFrame(this.video, w, h);
      else {
        this.canvas ??= document.createElement('canvas');
        this.canvas.width = w; this.canvas.height = h;
        const context = this.canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('پیش‌نمایش تشخیص در این مرورگر آماده نیست.');
        context.drawImage(this.video, 0, 0, w, h);
        image = { width: w, height: h, data: context.getImageData(0, 0, w, h).data };
      }
      const request: TrackingRequest = { id: ++this.id, generation: this.generation, phase: this.options.phase, expectedSequence: this.options.expectedSequence, displayBands:this.options.displayBands,mode: this.options.mode, purpose:this.options.purpose, frame, image };
      this.pending = request;
      this.analysisWidth = w; this.analysisHeight = h;
      this.pendingSlow = false; this.count('jobsStarted');
      this.submittedAt = now;
      this.lastPresented = metadata.presentedFrames;
      this.nextAt = now + this.interval;
      // Freshness expiry never preempts legitimate in-flight detector work.
      this.slowTimeout = setTimeout(() => {
        this.slowTimeout = null;
        if (!this.running || this.pending !== request) return;
        this.pendingSlow = true; this.reduceResolution();
        this.publishUnavailable('waiting', this.slowMessage(), 'slowProcessing');
      }, 2500);
      this.timeout = setTimeout(() => {
        if (!this.running || this.pending !== request) return;
        this.lastProcessingMs = performance.now() - this.capturedClock;
        this.count('timeouts');
        this.recover('workerTimeout', !this.pendingSlow);
      }, 8000);
      this.worker.postMessage(request, [image.data.buffer]);
    } catch (error) { this.fail(error); }
    finally { this.schedule(); }
  };

  private onMessage = (event: MessageEvent<TrackingResponse>) => {
    const response = event.data, pending = this.pending;
    if (!this.running || !pending || response.id !== pending.id || response.generation !== pending.generation) return;
    if (this.timeout !== null) clearTimeout(this.timeout);
    if (this.slowTimeout !== null) clearTimeout(this.slowTimeout);
    this.slowTimeout = null;
    this.timeout = null; this.pending = null;
    this.count('jobsCompleted');
    this.lastCompletedAt = performance.now();
    const age = performance.now() - this.capturedClock;
    this.lastProcessingMs = age;
    if (document.hidden) return;
    if (response.generation !== this.generation) {
      if (this.pendingSlow || age >= 2500 || (response.tracking?.processingMs ?? 0) >= 2500) this.recover('lateDetection', !this.pendingSlow);
      return;
    }
    if (response.frame.presentedFrames !== pending.frame.presentedFrames || response.frame.mediaTime !== pending.frame.mediaTime || response.frame.width !== pending.frame.width || response.frame.height !== pending.frame.height) return;
    if (response.error || !response.tracking) { this.workerFailure(new Error(response.error ?? 'Missing tracking result')); return; }
    const tracking = response.tracking;
    if (tracking.phase !== pending.phase || Object.keys(pending.frame).some(key => tracking.frame[key as keyof TrackingFrame] !== pending.frame[key as keyof TrackingFrame])) return;
    if (this.accepted && tracking.frame.presentedFrames <= this.accepted.presentedFrames) return;
    if (!Number.isFinite(tracking.processingMs) || tracking.processingMs < 0) { this.workerFailure(new Error('زمان پردازش ردیابی نامعتبر است.')); return; }
    this.workerErrors = 0;
    if (this.pendingSlow || age >= 2500 || tracking.processingMs >= 2500) { this.recover('lateDetection', !this.pendingSlow); return; }
    this.interval = Math.min(1000, Math.max(500, tracking.processingMs * 1.25));
    this.nextAt = this.submittedAt + this.interval;
    this.accepted = tracking.frame;
    this.lastStatus = tracking.status;
    const clockFallback = tracking.frame.timeSource === 'callbackClock';
    this.onUpdate({ ...tracking,relativeGeometryStable:tracking.geometryStable&&!tracking.moving, ...(clockFallback ? { geometryStable: false, nextAction: 'زمان ویدئو پیش نمی‌رود؛ فقط پیش‌نمایش و جبران نسبی آزمایشی فعال است، نه سنجش مطلق رنگ.' } : {}), debug: { ...tracking.debug, ...this.diagnostics(age), ...(clockFallback ? { reason: 'callbackClock' } : {}) }, fresh: !clockFallback });
    if (!this.running || document.hidden) return;
    if (this.starvation !== null) clearTimeout(this.starvation);
    this.starvation = setTimeout(() => {
      if (!this.running || document.hidden) return;
      this.publishUnavailable('waiting', 'فریم تازهٔ تشخیص نرسید؛ محدوده‌های قبلی کنار گذاشته شدند.');
    }, Math.max(1, 2500 - age));
  };
}
