import type { Patch } from './session';
import type { Frame, Point, Region } from './sampling';
export type ReferenceMeta = { id: string; label: string; source: string; version: string; valueType: 'XYZ' | 'Lab'; referenceWhite: 'D50' | 'D65'; observer: '2' | '10'; validity: 'verified' | 'unverified' };
export type Reference = ReferenceMeta & { xyzScale: 1; patches: { id: string; values: [number, number, number]; split: 'train' | 'holdout'; neutral: boolean }[]; geometry: Record<string, unknown> | null; health: Record<string, unknown> | null };
export function parseReference(text: string, metadata: ReferenceMeta): Reference {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && trimmed.split(/\r?\n/)[0].replace(/\s/g, '') !== 'id,v1,v2,v3,split,neutral') throw new Error('ستون‌های CSV باید id,v1,v2,v3,split,neutral باشند.');
  const target: Reference = trimmed.startsWith('{') ? JSON.parse(trimmed) : { ...metadata, xyzScale: 1, patches: trimmed.split(/\r?\n/).slice(1).filter(Boolean).map(row => {
    const fields = row.split(',').map(s => s.trim());
    const [id, a, b, c, split, neutral] = fields;
    if (fields.length !== 6 || [a, b, c].some(v => !v)) throw new Error('مقادیر خالی مرجع به صفر تبدیل نمی‌شوند.');
    if (!['true', 'false'].includes(neutral)) throw new Error('ستون neutral باید true یا false باشد.');
    return { id, values: [Number(a), Number(b), Number(c)], split, neutral: neutral === 'true' } as Reference['patches'][number];
  }), geometry: null, health: null };
  if (!target.id || !target.source || !target.version || !['XYZ', 'Lab'].includes(target.valueType) || !['D50', 'D65'].includes(target.referenceWhite) || !['2', '10'].includes(target.observer) || !['verified', 'unverified'].includes(target.validity) || target.xyzScale !== 1 || !Array.isArray(target.patches) || !target.patches.length || target.patches.length > 256 || target.patches.some(p => !p.id || p.values?.length !== 3 || p.values.some(v => !Number.isFinite(v)) || !['train', 'holdout'].includes(p.split) || typeof p.neutral !== 'boolean') || new Set(target.patches.map(p => p.id)).size !== target.patches.length) throw new Error('مرجع نامعتبر؛ مقادیر محدود و شناسه‌های یکتا لازم است.');
  return target;
}
export function normalizedRegion(region: Region, width: number, height: number): Region {
  const convert = (polygon: Point[]): Point[] => polygon.map(([x, y]) => {
    if (x < 0 || y < 0 || x > width || y > height || !width || !height) throw new Error('ناحیه خارج از تصویر اصلی است.');
    return [x / width, y / height];
  });
  return { ...region, polygon: convert(region.polygon), exclusions: region.exclusions.map(convert) };
}
export function referenceCaptureKey(regions: Region[], bindings: Record<string, string>) { return JSON.stringify({ regions, bindings }); }
export function groupCapacity(width: number, height: number) { return Math.max(1, Math.min(4, Math.floor((width - 24) / 200) * Math.max(1, Math.floor((height - 180) / 230)))); }
export function measurementPayload(region: Region, width: number, height: number, frames: Frame[], witnessFrames?: Frame[], cardFrames?: Frame[], cardPatchId?: string) {
  return { region: normalizedRegion(region, width, height), frames, sourceColorSpace: frames[0].colorSpace, sourceCaptureIds: frames.map(f => f.id), capturedAt: new Date().toISOString(), ...(witnessFrames ? { witnessFrames } : {}), ...(cardFrames ? { cardFrames, cardPatchId } : {}) };
}
// POST cannot currently cancel its server write; cancel waiting and prohibit all subsequent steps.
export function awaitWithSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('جلسه متوقف شد.'));
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new Error('جلسه متوقف شد.')); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw new Error('جلسه متوقف شد.'); return work(); }).then(value => {
      signal.removeEventListener('abort', aborted);
      if (signal.aborted) reject(new Error('جلسه متوقف شد.')); else resolve(value);
    }, error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}
export function waitForPatch(get: () => Patch | null, patchId: string, minimumSequence: number, signal: AbortSignal): Promise<Patch> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + 12000;
    const tick = () => {
      if (signal.aborted) { reject(new Error('جلسه متوقف شد.')); return; }
      const patch = get();
      if (patch?.patchId === patchId && patch.commandSequence >= minimumSequence && patch.rendered === true && patch.layout === 'single') { resolve(patch); return; }
      if (performance.now() > deadline) { reject(new Error('فرمان تازه یا تأیید رندر نمایشگر دریافت نشد.')); return; }
      setTimeout(tick, 40);
    }; tick();
  });
}
export const DISPLAY_GRID: { drive: [number, number, number]; split: 'train' | 'holdout' }[] = [
  { drive: [0.1, 0.1, 0.1], split: 'train' }, { drive: [0.8, 0.1, 0.1], split: 'train' }, { drive: [0.1, 0.8, 0.1], split: 'train' }, { drive: [0.1, 0.1, 0.8], split: 'train' }, { drive: [0.8, 0.8, 0.8], split: 'train' }, { drive: [0.4, 0.4, 0.4], split: 'train' }, { drive: [0.6, 0.3, 0.2], split: 'train' }, { drive: [0.2, 0.6, 0.3], split: 'train' },
  { drive: [0.3, 0.2, 0.6], split: 'holdout' }, { drive: [0.55, 0.55, 0.55], split: 'holdout' }, { drive: [0.2, 0.7, 0.7], split: 'holdout' },
];
type LoopPorts = { request: (drive: [number, number, number], id: string, sequence?: number) => Promise<{ patchId: string; commandSequence: number }>; capture: (command?: { patchId: string; commandSequence: number }) => Promise<Frame[][]>; post: (route: string, body: unknown) => Promise<Record<string, unknown>>; signal: AbortSignal; progress: (text: string) => void; cardPatchId?: string };
export async function runGrid(ports: LoopPorts & { fingerprint: string; cardPatchId?: string }) {
  const wait = <T,>(work: () => Promise<T>) => awaitWithSignal(ports.signal, work);
  const baselineCommand = await wait(() => ports.request([0, 0, 0], crypto.randomUUID()));
  const baseline = await wait(() => ports.capture(baselineCommand));
  const checks: Frame[][] = [];
  const fabricChecks: Frame[][] = [];
  for (const drive of [[1, 1, 1], [1, 0, 0]] as [number, number, number][]) {
    if (ports.signal.aborted) throw new Error('جلسه متوقف شد.');
    const command = await wait(() => ports.request(drive, crypto.randomUUID()));
    const captured = await wait(() => ports.capture(command));
    checks.push(captured[1]);
    if (captured[3]) fabricChecks.push(captured[3]);
  }
  const observations: Record<string, unknown>[] = [];
  for (const [index, entry] of DISPLAY_GRID.entries()) {
    if (ports.signal.aborted) throw new Error('جلسه متوقف شد.');
    ports.progress(`شبکهٔ نمایشگر: ${index + 1}/${DISPLAY_GRID.length}`);
    const command = await wait(() => ports.request(entry.drive, crypto.randomUUID()));
    const [frames, witnessFrames, cardFrames] = await wait(() => ports.capture(command));
    observations.push({ ...entry, frames, witnessFrames, cardPatchId: ports.cardPatchId ?? null, ...(cardFrames ? { cardFrames } : {}), commandSequence: command.commandSequence, patchId: command.patchId });
  }
  return wait(() => ports.post('display-profile', { observations, contaminationBaseline: baseline[1], contaminationChecks: checks, ...(baseline[3] ? { contaminationFabricBaseline: baseline[3], contaminationFabricChecks: fabricChecks } : {}), layout: 'single', fingerprint: ports.fingerprint }));
}
export async function runMatch(measurementId: string, ports: LoopPorts) {
  const wait = <T,>(work: () => Promise<T>) => awaitWithSignal(ports.signal, work);
  let result = await wait(() => ports.post('matches', { measurementId, maxEvaluations: 40, target: 0.01, noiseFloor: 0.002 }));
  const runId = result.runId;
  for (let iteration = 0; result.nextDrive && iteration < 40; iteration++) {
    if (ports.signal.aborted) throw new Error('جلسه متوقف شد.');
    if (!Array.isArray(result.nextDrive) || result.nextDrive.length !== 3 || result.nextDrive.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('فرمان سرور نامعتبر است.');
    ports.progress(`تطبیق فیزیکی: ${iteration + 1}/40`);
    const command = await wait(() => ports.request(result.nextDrive as [number, number, number], String(result.patchId ?? ''), Number(result.commandSequence ?? 0)));
    const [frames, witnessFrames, cardFrames, fabricFrames] = await wait(() => ports.capture(command));
    result = await wait(() => ports.post(`matches/${encodeURIComponent(String(runId))}/observe`, { frames, witnessFrames, ...(cardFrames ? { cardFrames, cardPatchId: ports.cardPatchId } : {}), ...(fabricFrames ? { fabricFrames } : {}), markerSequence: command.commandSequence, commandSequence: command.commandSequence, patchId: command.patchId, stable: true, layout: 'single' }));
  }
  if (result.nextDrive) throw new Error('سقف ۴۰ ارزیابی رسید؛ ادامه متوقف شد. این نتیجه اثبات خارج‌بودن از گاموت نیست.');
  if (Array.isArray(result.bestDrive) && result.bestDrive.length === 3 && result.bestDrive.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) {
    await wait(() => ports.request(result.bestDrive as [number, number, number], crypto.randomUUID()));
    result = { ...result, terminalDisplay: 'renderedBestDriveOnly' };
  }
  return result;
}
export async function runCameraMatch(region: Region, width: number, height: number, ports: LoopPorts & { targetFrames: Frame[] }) {
  const wait = <T,>(work: () => Promise<T>) => awaitWithSignal(ports.signal, work);
  let result = await wait(() => ports.post('camera-matches', { ...measurementPayload(region, width, height, ports.targetFrames), maxEvaluations: 40, target: 0.01, noiseFloor: 0.002 }));
  const measurementId = result.measurementId, runId = result.runId;
  for (let iteration = 0; result.nextDrive && iteration < 40; iteration++) {
    if (!Array.isArray(result.nextDrive) || result.nextDrive.length !== 3 || result.nextDrive.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('فرمان سرور نامعتبر است.');
    ports.progress(`تطبیق زندهٔ آزمایشی: ${iteration + 1}/40`);
    const command = await wait(() => ports.request(result.nextDrive as [number, number, number], String(result.patchId ?? ''), Number(result.commandSequence ?? 0)));
    const [frames, fabricFrames] = await wait(() => ports.capture(command));
    result = await wait(() => ports.post(`camera-matches/${encodeURIComponent(String(runId))}/observe`, { frames, fabricFrames, markerSequence: command.commandSequence, commandSequence: command.commandSequence, patchId: command.patchId, stable: true, layout: 'single' }));
  }
  if (result.nextDrive) throw new Error('سقف ۴۰ ارزیابی رسید؛ تطبیق آزمایشی متوقف شد.');
  if (Array.isArray(result.bestDrive) && result.bestDrive.length === 3 && result.bestDrive.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) {
    await wait(() => ports.request(result.bestDrive as [number, number, number], crypto.randomUUID()));
    result = { ...result, terminalDisplay: 'renderedBestDriveOnly' };
  }
  return { ...result, measurementId };
}
