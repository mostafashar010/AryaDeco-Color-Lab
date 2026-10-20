import { bounds, type Frame, type Region, type sampleRegion } from './sampling';
import { decodeMarker, sampleMarker, type PixelImage, type Rect } from './marker';

export type AutoLockStatus = 'unknown' | 'locked' | 'partial' | 'unverified' | 'unsupported' | 'failed';
export type AutoLockReport = { status: AutoLockStatus; applied: string[]; unverified: string[]; unsupported: string[]; failed: string[]; values: Record<string, number | string> };

export class Camera {
  stream?: MediaStream;
  track?: MediaStreamTrack;
  private requested: Record<string, unknown> = {};
  private lockStatus: AutoLockStatus = 'unknown';
  constructor(private media: MediaDevices, private pause: (reason: string) => void) {}
  async start(deviceId?: string) {
    this.stop();
    const video = deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } } : { facingMode: { exact: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } };
    this.requested = { audio: false, video };
    this.stream = await this.media.getUserMedia({ audio: false, video });
    this.track = this.stream.getVideoTracks()[0];
    if (!this.track) throw new Error('دوربین ویدئویی در دسترس نیست.');
    this.track.addEventListener('ended', () => this.pause('camera_track_ended'));
    return this.stream;
  }
  async controls(values: Record<string, unknown>) {
    if (!this.track) throw new Error('دوربین فعال نیست.');
    this.requested = { ...this.requested, controls: values };
    try { await this.track.applyConstraints({ advanced: [values as MediaTrackConstraintSet] }); }
    finally { this.pause('camera_controls_changed'); }
  }
  /**
   * Best-effort lock of auto exposure and auto white balance at their CURRENT values, so the
   * closed feedback loop is not chasing the camera's own adjustments (which also change
   * fingerprint() and reset the loop). Call it once the scene is framed and exposure has
   * settled, never right after start(). Unlike controls() it does not call pause(): run it
   * before a measured session begins; fingerprint() reflects the locked state afterwards.
   *
   * A group is locked only when the browser reports the current numeric value (a bare
   * "manual" mode would freeze an arbitrary default) and, to claim success, reports
   * the manual mode back in getSettings(). Anything weaker is reported honestly.
   */
  async lockAuto(): Promise<AutoLockReport> {
    const track = this.track;
    if (!track) throw new Error('دوربین فعال نیست.');
    const read = () => (track.getSettings?.() ?? {}) as Record<string, unknown>;
    const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const before = read();
    const canManual = (key: string) => Array.isArray(caps[key]) && (caps[key] as unknown[]).includes('manual');
    const current = (key: string) => (caps[key] !== undefined && typeof before[key] === 'number' && Number.isFinite(before[key]) ? { [key]: before[key] as number } : undefined);
    const exposureTime = current('exposureTime'), colorTemperature = current('colorTemperature');
    const plan: { name: string; modeKey: string; values?: Record<string, number | string> }[] = [
      { name: 'exposure', modeKey: 'exposureMode', values: canManual('exposureMode') && exposureTime ? { exposureMode: 'manual', ...exposureTime, ...current('iso') } : undefined },
      { name: 'whiteBalance', modeKey: 'whiteBalanceMode', values: canManual('whiteBalanceMode') && colorTemperature ? { whiteBalanceMode: 'manual', ...colorTemperature } : undefined },
    ];
    const applied: string[] = [], unverified: string[] = [], unsupported: string[] = [], failed: string[] = [];
    const values: Record<string, number | string> = {};
    for (const step of plan) {
      if (!step.values) { unsupported.push(step.name); continue; }
      // One group per call: a browser that rejects one must not block the other.
      try { await track.applyConstraints({ advanced: [step.values as MediaTrackConstraintSet] }); }
      catch { failed.push(step.name); continue; }
      Object.assign(values, step.values);
      (read()[step.modeKey] === 'manual' ? applied : unverified).push(step.name);
    }
    this.requested = { ...this.requested, controls: { ...((this.requested.controls as Record<string, unknown> | undefined) ?? {}), ...values } };
    this.lockStatus = applied.length === plan.length ? 'locked' : applied.length ? 'partial' : unverified.length ? 'unverified' : failed.length ? 'failed' : 'unsupported';
    return { status: this.lockStatus, applied, unverified, unsupported, failed, values };
  }
  report() {
    return { browserSupported: true, supportedConstraints: this.media.getSupportedConstraints(), trackCapabilities: this.track?.getCapabilities?.() ?? {}, requested: this.requested, reportedSettings: this.track?.getSettings() ?? {}, controlStatus: { manualLock: this.lockStatus, wakeLock: 'unknown', reportedConstraints: this.track?.getConstraints?.() ?? {} }, deviceLabel: this.track?.label ?? '', capturePath: 'videoCanvas', canvasColorSpace: 'unknown', wakeLock: false };
  }
  fingerprint() {
    const text = JSON.stringify({ requested: this.requested, settings: this.track?.getSettings() ?? {} });
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `settings-fnv1a-${(hash >>> 0).toString(16)}-${text.length}`;
  }
  stop() { this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined; this.track = undefined; this.lockStatus = 'unknown'; }
}
export function readCanvasPixels(ctx: CanvasRenderingContext2D, rect: Rect, colorSpace: 'srgb' | 'display-p3'): PixelImage {
  const result = ctx.getImageData(rect.x, rect.y, rect.width, rect.height, { colorSpace, pixelFormat: 'rgba-float16' });
  if (result.colorSpace !== colorSpace) throw new Error('فضای رنگ بازگشتی canvas با درخواست یکی نیست.');
  if (!(result.data instanceof Float32Array) && Object.prototype.toString.call(result.data) !== '[object Float16Array]') throw new Error('مسیر float canvas پشتیبانی نشد؛ نمونهٔ قابل اعتماد ارسال نشد.');
  return { data: result.data, width: result.width ?? rect.width, height: result.height ?? rect.height };
}
export function verifyCanvas(canvas: HTMLCanvasElement, colorSpace: 'srgb' | 'display-p3') {
  canvas.width = 2; canvas.height = 2;
  const ctx = canvas.getContext('2d', { colorSpace, willReadFrequently: true });
  if (!ctx) throw new Error('مسیر canvas در دسترس نیست.');
  if (ctx.getContextAttributes?.().colorSpace && ctx.getContextAttributes().colorSpace !== colorSpace) throw new Error('فضای backing canvas با درخواست یکی نیست.');
  readCanvasPixels(ctx, { x: 0, y: 0, width: 2, height: 2 }, colorSpace);
  return colorSpace;
}
export function verifyCameraPath(camera: Camera, canvas: HTMLCanvasElement, colorSpace: 'srgb' | 'display-p3') {
  try { return verifyCanvas(canvas, colorSpace); }
  catch (error) { camera.stop(); throw error; }
}
export function assertSeparated(regions: Region[], marker: Rect) {
  for (const region of regions) {
    const b = bounds(region.polygon);
    if (b.x < marker.x + marker.width && b.x + b.width > marker.x && b.y < marker.y + marker.height && b.y + b.height > marker.y) throw new Error('ناحیهٔ رنگ/شاهد با نشانگر هم‌پوشانی دارد.');
  }
}
type BatchPixels = { markerPixels?: number[][]; images: PixelImage[]; offsets: { x: number; y: number }[]; colorSpace: 'srgb' | 'display-p3'; fingerprint: string; width?: number; height?: number };
type Sampler = (image: PixelImage, offset: { x: number; y: number }, region: Region) => Promise<ReturnType<typeof sampleRegion>>;
export function collectFrames(video: HTMLVideoElement, regions: Region[], read: () => Promise<BatchPixels>, sample: Sampler, signal: AbortSignal, expectedMarker?: number): Promise<Frame[][]> {
  return collectBatch(video, regions, read, sample, signal, expectedMarker, false);
}
export function collectRelativeFrames(video: HTMLVideoElement, regions: Region[], read: () => Promise<BatchPixels>, sample: Sampler, signal: AbortSignal, expectedMarker: number): Promise<Frame[][]> {
  return collectBatch(video, regions, read, sample, signal, expectedMarker, true);
}
function collectBatch(video: HTMLVideoElement, regions: Region[], read: () => Promise<BatchPixels>, sample: Sampler, signal: AbortSignal, expectedMarker: number | undefined, relative: boolean): Promise<Frame[][]> {
  return new Promise((resolve, reject) => {
    if (!video.requestVideoFrameCallback) { reject(new Error('فریم ویدئو یکتا در این مرورگر قابل تأیید نیست.')); return; }
    const result: Frame[][] = regions.map(() => []);
    const identities = new Set<string>(); let first = -1; let handle = 0; let done = false; let fingerprint = '';
    let lastPresented = -1, lastMediaTime = -1;
    const timeout = setTimeout(() => finish(new Error('دریافت ۱۰ فریم تازه در مهلت مجاز انجام نشد.')), 15000);
    const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timeout); signal.removeEventListener('abort', aborted); video.cancelVideoFrameCallback?.(handle); error ? reject(error) : resolve(result); };
    const aborted = () => finish(new Error('نمونه‌برداری به دلیل توقف جلسه لغو شد.'));
    const next = () => { handle = video.requestVideoFrameCallback(async (now, metadata) => {
      if (done || signal.aborted) { aborted(); return; }
      const identity = `${metadata.presentedFrames}:${metadata.mediaTime}`;
      if (!Number.isFinite(metadata.mediaTime) || metadata.mediaTime < 0 || !Number.isSafeInteger(metadata.presentedFrames) || metadata.presentedFrames < 0 || metadata.presentedFrames < lastPresented || metadata.mediaTime < lastMediaTime) { finish(new Error('شناسهٔ واقعی ویدئو تازه و افزایشی نیست.')); return; }
      if (identities.has(identity) || (first >= 0 && now - result[0].at(-1)!.capturedAt < 110)) { next(); return; }
      if ((!relative || metadata.mediaTime !== 0) && metadata.presentedFrames > lastPresented && metadata.mediaTime === lastMediaTime) { finish(new Error('مرورگر زمان ویدئو را ثابت گزارش می‌کند؛ پیش‌نمایش زنده کار می‌کند اما برداشت دقیق در این مسیر تأیید نمی‌شود. از نمایش زندهٔ کالیته استفاده کنید.')); return; }
      if (metadata.presentedFrames === lastPresented) { next(); return; }
      lastPresented = metadata.presentedFrames; lastMediaTime = metadata.mediaTime;
      identities.add(identity);
      try {
        const batch = await read();
        const sequence = batch.markerPixels ? decodeMarker(batch.markerPixels) : null;
        if (expectedMarker !== undefined && sequence !== expectedMarker) throw new Error('نشانگر فیزیکی مربوط به فرمان جاری نیست.');
        if (fingerprint && fingerprint !== batch.fingerprint) throw new Error('تنظیمات دوربین حین برداشت تغییر کرد.');
        fingerprint = batch.fingerprint;
        for (let i = 0; i < regions.length; i++) {
          const samples = await sample(batch.images[i], batch.offsets[i], regions[i]);
          if (done || signal.aborted) { aborted(); return; }
          const width = batch.width ?? batch.images[i].width, height = batch.height ?? batch.images[i].height;
          const normalize = (p: [number, number][]): [number, number][] => p.map(([x, y]) => [x / width, y / height]);
          result[i].push({ id: crypto.randomUUID(), capturedAt: now, ...samples, colorSpace: batch.colorSpace, encoding: 'encoded', source: 'videoCanvas', settingsFingerprint: fingerprint, markerSequence: sequence, presentedFrames: metadata.presentedFrames, mediaTime: metadata.mediaTime, width, height, regionId: regions[i].id, roi: normalize(regions[i].polygon), exclusions: regions[i].exclusions.map(normalize), sharpnessStatus: 'notAssessed', ...(batch.markerPixels ? { markerPixels: batch.markerPixels } : {}) });
        }
        if (first < 0) first = now;
        if (result[0].length >= 10 && now - first >= 1000) finish(); else next();
      } catch (e) { finish(e instanceof Error ? e : new Error('خطای برداشت')); }
    }); };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else next();
  });
}

export class CapturePipeline {
  private canvas = document.createElement('canvas');
  private worker = new Worker(new URL('./sampling.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: ReturnType<typeof sampleRegion>) => void; reject: (error: Error) => void }>();
  constructor() {
    this.worker.onmessage = event => { const p = this.pending.get(event.data.id); this.pending.delete(event.data.id); if (event.data.error) p?.reject(new Error(event.data.error)); else p?.resolve(event.data.result); };
    this.worker.onerror = () => { for (const p of this.pending.values()) p.reject(new Error('worker نمونه‌برداری متوقف شد.')); this.pending.clear(); };
  }
  private sample: Sampler = (image, offset, region) => new Promise((resolve, reject) => {
    const id = ++this.nextId; this.pending.set(id, { resolve, reject });
    this.worker.postMessage({ id, image, offset, region }, [image.data.buffer]);
  });
  async capture(video: HTMLVideoElement, regions: Region[], camera: Camera, signal: AbortSignal, marker?: Rect, sequence?: number, colorSpace: 'srgb' | 'display-p3' = 'srgb') {
    return this.captureBatch(video, regions, camera, signal, marker, sequence, colorSpace, false);
  }
  async captureRelative(video: HTMLVideoElement, regions: Region[], camera: Camera, signal: AbortSignal, marker: Rect, sequence: number, colorSpace: 'srgb' | 'display-p3' = 'srgb') {
    return this.captureBatch(video, regions, camera, signal, marker, sequence, colorSpace, true);
  }
  private async captureBatch(video: HTMLVideoElement, regions: Region[], camera: Camera, signal: AbortSignal, marker: Rect | undefined, sequence: number | undefined, colorSpace: 'srgb' | 'display-p3', relative: boolean) {
    if (!video.videoWidth || !video.videoHeight || !regions.length) throw new Error('دوربین یا ناحیه آماده نیست.');
    if (marker) assertSeparated(regions, marker);
    this.canvas = document.createElement('canvas');
    verifyCanvas(this.canvas, colorSpace);
    this.canvas.width = video.videoWidth; this.canvas.height = video.videoHeight;
    const ctx = this.canvas.getContext('2d', { colorSpace, willReadFrequently: true });
    if (!ctx) throw new Error('canvas در دسترس نیست.');
    return collectBatch(video, regions, async () => {
      ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
      let markerPixels: number[][] | undefined;
      if (marker) {
        const local = readCanvasPixels(ctx, marker, colorSpace);
        markerPixels = sampleMarker(local, { x: 0, y: 0, width: local.width, height: local.height });
      }
      const rects = regions.map(r => bounds(r.polygon));
      if (rects.some(r => r.x + r.width > video.videoWidth || r.y + r.height > video.videoHeight || r.width < 1 || r.height < 1)) throw new Error('ناحیه از تصویر اصلی بیرون است.');
      return { markerPixels, images: rects.map(r => readCanvasPixels(ctx, r, colorSpace)), offsets: rects.map(r => ({ x: r.x, y: r.y })), colorSpace, fingerprint: camera.fingerprint(), width: video.videoWidth, height: video.videoHeight };
    }, this.sample, signal, sequence, relative);
  }
  stop() { this.worker.terminate(); for (const p of this.pending.values()) p.reject(new Error('برداشت لغو شد.')); this.pending.clear(); }
}
