import type { LiveScene } from './liveScene';
import { detectLiveScene } from './liveScene';
import type { Mode } from './session';
import type { Region } from './sampling';
import { awaitWithSignal, type Reference } from './workflow';
import { detectNeutralCards, type NeutralCards } from './neutralCards';

export function sceneRegions(scene: LiveScene): Region[] {
  return [scene.displayRegion, ...scene.fabricRegions].filter((r): r is NonNullable<typeof r> => Boolean(r)).map(r => ({ id: r.id, label: r.label, order: r.order, mode: r.mode, polygon: r.polygon, exclusions: r.exclusions, background: r.background, layers: r.layers, direction: r.direction, operatorConfirmed: false, selectionMethod: 'autoDetected' }));
}
export function guidedSceneAction(scene: LiveScene | null, mode: Mode, hasReference: boolean) {
  if (!scene) return 'صفحهٔ گوشی A را سمت راست و پارچهٔ صاف را سمت چپ قاب بگذارید؛ سپس تشخیص خودکار چیدمان را بزنید.';
  if (scene.status !== 'ready') return scene.nextAction;
  if (mode !== 'cameraMatch' && !hasReference) return 'برای مسیر مرجع‌دار، فایل مقادیر واقعی کارت لازم است؛ تطبیق سادهٔ بدون کارت قابلیت آزمایشیِ جداست و کالیبراسیون کامل نیست.';
  return scene.nextAction;
}
export function suppliedReferenceRegions(reference: Reference, scene: LiveScene, width: number, height: number) {
  const geometry = reference.geometry;
  if (!geometry || geometry.coordinateSystem !== 'displayRelative' || !scene.displayRegion || !Array.isArray(geometry.patches) || !Array.isArray(geometry.witnessPolygon) || typeof geometry.cardPatchId !== 'string') return null;
  const screen = scene.displayRegion.polygon;
  const x0 = Math.min(...screen.map(p => p[0])), y0 = Math.min(...screen.map(p => p[1]));
  const sw = Math.max(...screen.map(p => p[0])) - x0, sh = Math.max(...screen.map(p => p[1])) - y0;
  const polygon = (value: unknown): [number, number][] => {
    if (!Array.isArray(value) || value.length < 3 || value.length > 128) throw new Error('چیدمان ثبت‌شدهٔ کارت معتبر نیست.');
    return value.map(point => { if (!Array.isArray(point) || point.length !== 2 || point.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('چیدمان ثبت‌شدهٔ کارت معتبر نیست.'); const x = x0 + point[0] * sw, y = y0 + point[1] * sh; if (x < 0 || y < 0 || x > width || y > height) throw new Error('کارت از چیدمان ثبت‌شده خارج قاب است؛ گوشی‌ها را مطابق چیدمان مرجع قرار دهید.'); return [x, y]; });
  };
  const make = (id: string, label: string, p: unknown): Region => ({ id, label, order: 0, mode: 'solid', polygon: polygon(p), exclusions: [], background: null, layers: null, direction: null, operatorConfirmed: false, selectionMethod: 'autoDetected' });
  const bindings: Record<string, string> = {};
  const regions = geometry.patches.map(value => { const patch = value as { patchId?: unknown; polygon?: unknown }; if (typeof patch.patchId !== 'string' || !reference.patches.some(p => p.id === patch.patchId) || bindings[patch.patchId]) throw new Error('شناسه‌های چیدمان کارت با مرجع ثبت‌شده یکسان نیست.'); const r = make(`auto-reference-${patch.patchId}`, `پچ مرجع ${patch.patchId}`, patch.polygon); bindings[patch.patchId] = r.id; return r; });
  if (reference.patches.some(p => !bindings[p.id]) || !bindings[geometry.cardPatchId]) throw new Error('چیدمان باید تمام پچ‌های واقعی train و holdout را مستقل داشته باشد.');
  const witness = make('auto-reference-witness', 'شاهد چیدمان ثبت‌شده', geometry.witnessPolygon);
  const all = [...regions, witness, ...sceneRegions(scene)];
  for (const [i, a] of all.entries()) for (const b of all.slice(i + 1)) {
    const box = (r: Region) => [Math.min(...r.polygon.map(p => p[0])), Math.min(...r.polygon.map(p => p[1])), Math.max(...r.polygon.map(p => p[0])), Math.max(...r.polygon.map(p => p[1]))];
    const aa = box(a), bb = box(b);
    if (!(aa[2] <= bb[0] || bb[2] <= aa[0] || aa[3] <= bb[1] || bb[3] <= aa[1])) throw new Error('چیدمان ثبت‌شده هم‌پوشانی دارد؛ کارت و پارچه مطابق فایل مرجع جدا قرار گیرند.');
  }
  return { regions: [...regions, witness], bindings, witnessId: witness.id, cardId: bindings[geometry.cardPatchId], cardPatchId: geometry.cardPatchId };
}
async function scanPreview<T extends { status: string }>(video: HTMLVideoElement, signal: AbortSignal, detect: (image: { width: number; height: number; data: Uint8ClampedArray }) => T): Promise<T> {
  if (!video.videoWidth || !video.videoHeight || !video.requestVideoFrameCallback) throw new Error('دوربین هنوز فریم زندهٔ قابل بررسی ندارد؛ مجوز دوربین را بدهید و قاب را ثابت نگه دارید.');
  // Preview pixels serve geometry only. Scientific capture still uses native float video frames.
  const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas'); canvas.width = Math.floor(video.videoWidth * scale); canvas.height = Math.floor(video.videoHeight * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('پیش‌نمایش تشخیص خودکار در این مرورگر در دسترس نیست.');
  let lastIdentity = '';
  let scene: T | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await awaitWithSignal(signal, () => new Promise<void>((resolve, reject) => {
      let handle = 0;
      const done = (error?: Error) => { clearTimeout(timer); signal.removeEventListener('abort', abort); video.cancelVideoFrameCallback?.(handle); error ? reject(error) : resolve(); };
      const abort = () => done(new Error('جلسه متوقف شد.'));
      const timer = setTimeout(() => done(new Error('فریم تازهٔ دوربین نرسید؛ دوربین و نور را بررسی کنید.')), 3000);
      const next = () => { handle = video.requestVideoFrameCallback((_time, metadata) => { const identity = `${metadata.presentedFrames}:${metadata.mediaTime}`; if (identity === lastIdentity) next(); else { lastIdentity = identity; done(); } }); };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); else next();
    }));
    if (signal.aborted) throw new Error('جلسه متوقف شد.');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    scene = detect({ width: canvas.width, height: canvas.height, data: pixels.data });
    if (scene.status === 'ready') break;
  }
  if (!scene) throw new Error('تشخیص چیدمان انجام نشد.');
  return scene;
}
export async function scanLiveScene(video: HTMLVideoElement, expectedSequence: number, signal: AbortSignal, mode: Mode = 'threeStage'): Promise<LiveScene> {
  const scene = await scanPreview(video, signal, image => detectLiveScene(image, expectedSequence, { requireReferenceIdentity: mode !== 'cameraMatch' }));
  const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
  const sx = video.videoWidth / Math.floor(video.videoWidth * scale), sy = video.videoHeight / Math.floor(video.videoHeight * scale);
  const map = (r: LiveScene['fabricRegions'][number]) => ({ ...r, polygon: r.polygon.map(([x, y]) => [x * sx, y * sy] as [number, number]), exclusions: r.exclusions.map(p => p.map(([x, y]) => [x * sx, y * sy] as [number, number])), selectionMethod: 'autoDetected' as const, operatorConfirmed: false });
  return { ...scene, ...(scene.displayRegion ? { displayRegion: map(scene.displayRegion) } : {}), ...(scene.marker ? { marker: { x: scene.marker.x * sx, y: scene.marker.y * sy, width: scene.marker.width * sx, height: scene.marker.height * sy } } : {}), fabricRegions: scene.fabricRegions.map(map), neutralCandidates: scene.neutralCandidates.map(map) };
}
export async function scanLiveNeutralCards(video: HTMLVideoElement, signal: AbortSignal): Promise<NeutralCards> {
  const cards = await scanPreview(video, signal, detectNeutralCards);
  const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
  const sx = video.videoWidth / Math.floor(video.videoWidth * scale), sy = video.videoHeight / Math.floor(video.videoHeight * scale);
  return { ...cards, cards: cards.cards.map(c => ({ ...c, region: { ...c.region, polygon: c.region.polygon.map(([x, y]) => [x * sx, y * sy] as [number, number]), exclusions: c.region.exclusions.map(p => p.map(([x, y]) => [x * sx, y * sy] as [number, number])) } })) };
}
