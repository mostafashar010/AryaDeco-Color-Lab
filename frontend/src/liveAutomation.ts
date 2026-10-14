import type { Mode, Snapshot } from './session';
import type { Frame, Region } from './sampling';
import type { Rect } from './marker';
import { awaitWithSignal, measurementPayload, type Reference } from './workflow';

export type LiveContext = { mode: Mode; snapshot: Snapshot; cameraReady: boolean; reference: Reference | null; regions: Region[]; bindings: Record<string, string>; roles: { display: string; witness: string; card: string; fabric: string }; marker: Rect | null; cardPatchId: string; width: number; height: number };
export type LiveItem = { regionId: string; label: string; status: 'queued' | 'capturing' | 'measured' | 'matching' | 'complete' | 'stopped' | 'rejected'; measurement?: Record<string, unknown>; match?: Record<string, unknown>; error?: string };
export type LivePorts = { getContext: () => LiveContext; readServer: () => Promise<Snapshot>; capture: (regions: Region[], signal: AbortSignal) => Promise<Frame[][]>; fingerprint: () => string; post: (route: string, body: unknown) => Promise<Record<string, unknown>>; grid: (signal: AbortSignal) => Promise<Record<string, unknown>>; match: (id: string, fabric: Region, signal: AbortSignal) => Promise<Record<string, unknown>>; signal: AbortSignal; progress: (text: string) => void; item: (item: LiveItem) => void };
export type LiveRequirement = { id: string; text: string };
export function fabricRegions(context: LiveContext) {
  const excluded = new Set([...Object.values(context.bindings), context.roles.display, context.roles.witness, context.roles.card]);
  return context.regions.filter(r => !excluded.has(r.id)).sort((a, b) => a.order - b.order);
}
export function nextLiveRequirement(c: LiveContext): LiveRequirement | null {
  const missing = (id: string, text: string) => ({ id, text });
  if (c.mode === 'replay') return missing('replay', 'بازپخش مسیر جداست؛ تصویر اصلی را با رضایت بارگذاری کنید.');
  if (!c.cameraReady) return missing('camera', 'دوربین ثابت را انتخاب و «فعال‌کردن دوربین B» را بزنید.');
  const selected = (r?: Region) => r && (r.operatorConfirmed || r.selectionMethod === 'autoDetected');
  if (c.mode === 'cameraMatch') {
    if (!(c.snapshot.capabilities as { display?: unknown } | undefined)?.display) return missing('display', 'گوشی A را با QR وصل کنید و صفحهٔ آن را باز نگه دارید.');
    if (!selected(c.regions.find(r => r.id === c.roles.display)) || !c.marker || !fabricRegions(c).length) return missing('scene', 'نمایشگر سمت راست و پارچهٔ صاف سمت چپ باشد؛ تشخیص خودکار چیدمان را بزنید.');
    if (c.snapshot.paused) return missing('paused', 'چیدمان و شرایط ثابت را بررسی کنید؛ سپس شروع خودکار را بزنید.');
    return null;
  }
  const target = c.snapshot.references as Reference | undefined;
  const reference = target?.patches ? target : c.snapshot.references === undefined ? c.reference : null;
  if (!reference?.patches?.length) return missing('reference', 'فایل مقادیر مرجع فیزیکی واقعی را ثبت کنید؛ رنگ مرجع حدس زده نمی‌شود.');
  if (!c.snapshot.cameraProfile) {
    const bound = reference.patches.map(p => c.regions.find(r => r.id === c.bindings[p.id]));
    if (bound.some(r => !selected(r)) || new Set(bound.map(r => r?.id)).size !== bound.length) return missing('bindings', 'چیدمان ثبت‌شدهٔ کارت برای نگاشت خودکار پچ‌ها در دسترس نیست؛ مقادیر و هویت پچ‌ها حدس زده نمی‌شوند.');
  }
  if (c.mode === 'threeStage' && !(c.snapshot.capabilities as { display?: unknown } | undefined)?.display) return missing('display', 'گوشی A را وصل کنید؛ گزارش واقعی نمایشگر هنوز از سرور دریافت نشده است.');
  const names = c.mode === 'threeStage' ? [['display', 'رنگ نمایشگر A'], ['witness', 'شاهد خنثی'], ['card', 'کارت مرجع'], ['fabric', 'اولین نمونهٔ پارچه']] as const : [['witness', 'شاهد خنثی'], ['card', 'کارت مرجع']] as const;
  for (const [role, label] of names) if (!selected(c.regions.find(r => r.id === c.roles[role]))) return missing(role, `${label} در چیدمان شناسایی نشده است؛ کارت پایین قاب و نمایشگر و پارچه مستقیم و کامل دیده شوند.`);
  if (new Set(names.map(([role]) => c.roles[role])).size !== names.length) return missing('roles', 'کارت، شاهد، نمایشگر و پارچه باید ناحیه‌های جدا داشته باشند.');
  const cardPatch = reference.patches.find(p => p.id === c.cardPatchId);
  if (!cardPatch || (c.mode === 'catalogOnly' && !cardPatch.neutral)) return missing('cardPatch', 'پچ واقعی متناظر کارت را انتخاب کنید؛ در فقط کاتالوگ باید خنثی باشد.');
  if (c.mode === 'threeStage' && !c.marker) return missing('marker', 'با ابزار نشانگر، نوار سیاه‌وسفید گوشی A را مشخص کنید.');
  const samples = fabricRegions(c);
  if (!samples.length) return missing('samples', 'دست‌کم یک نمونهٔ پارچه جدا از تمام پچ‌های مرجع رسم کنید.');
  if (samples.some(r => !selected(r))) return missing('confirmation', 'ناحیه‌های پارچه هنوز شناسایی نشده‌اند؛ قاب را صاف و بدون چین یا بازتاب نگه دارید.');
  if (c.snapshot.paused) return missing('paused', 'شاهد و شرایط ثابت را بررسی کنید و تأیید اولیه را علامت بزنید؛ سپس شروع خودکار را بزنید.');
  return null;
}

export async function runLiveAutomation(ports: LivePorts): Promise<LiveItem[]> {
  const wait = <T,>(work: () => Promise<T>) => awaitWithSignal(ports.signal, work);
  let server = await wait(ports.readServer);
  const context = () => ({ ...ports.getContext(), snapshot: server });
  const requirement = nextLiveRequirement(context());
  if (requirement) throw new Error(requirement.text);
  const read = async () => {
    server = await wait(ports.readServer);
    if (server.paused) throw new Error('جلسه متوقف شد؛ شروع مجدد فقط پس از بررسی اپراتور.');
    return context();
  };
  let c = context();
  if (!server.cameraProfile) {
    ports.progress('۱ / برداشت خودکار ۱۰ فریم تازه از پچ‌های کارت واقعی');
    const reference = ((server.references as Reference | undefined)?.patches ? server.references : c.reference) as Reference;
    const regions = reference.patches.map(p => c.regions.find(r => r.id === c.bindings[p.id])!);
    const frames = await wait(() => ports.capture(regions, ports.signal));
    await wait(() => ports.post('camera-profile', { observations: reference.patches.map((p, i) => ({ patchId: p.id, frames: frames[i] })), fingerprint: ports.fingerprint() }));
    c = await read();
    if (!server.cameraProfile || server.state === 'reference' || server.state === 'camera') throw new Error('برازش دوربین در وضعیت واقعی سرور تکمیل نشده است.');
  }
  if (c.mode === 'threeStage' && !server.displayProfile) {
    ports.progress('۲ / چرخهٔ خودکار رنگ نمایشگر، شاهد و کارت');
    await wait(() => ports.grid(ports.signal));
    c = await read();
    if (!server.displayProfile || server.state !== 'fabric') throw new Error('جبران نمایشگر در وضعیت واقعی سرور تکمیل نشده است.');
  }
  if (server.state !== 'fabric') throw new Error('سرور هنوز در مرحلهٔ پارچه نیست؛ ترتیب مراحل قابل دورزدن نیست.');
  const profileVersion = server.profileVersion;
  const fingerprint = ports.fingerprint();
  const samples = fabricRegions(c);
  const rows: LiveItem[] = samples.map(r => ({ regionId: r.id, label: r.label, status: 'queued' }));
  rows.forEach(ports.item);
  const update = (index: number, patch: Partial<LiveItem>) => { rows[index] = { ...rows[index], ...patch }; ports.item(rows[index]); };
  for (const [index, region] of samples.entries()) {
    c = await read();
    if (ports.fingerprint() !== fingerprint || server.profileVersion !== profileVersion || !server.cameraProfile || server.state !== 'fabric' || (c.mode === 'threeStage' && !server.displayProfile)) throw new Error('پروفایل‌ها یا تنظیمات دوربین تغییر کردند؛ برداشت صف متوقف شد.');
    ports.progress(`۳ / برداشت خودکار نمونه ${index + 1}/${samples.length}: ${region.label}`);
    update(index, { status: 'capturing' });
    const witness = c.regions.find(r => r.id === c.roles.witness)!;
    const card = c.regions.find(r => r.id === c.roles.card)!;
    const [frames, witnessFrames, cardFrames] = await wait(() => ports.capture([region, witness, card], ports.signal));
    const measurement = await wait(() => ports.post('measurements', measurementPayload(region, c.width, c.height, frames, witnessFrames, cardFrames, c.cardPatchId)));
    const rejected = measurement.captureQuality === 'rejected' || (measurement.quality as { status?: string } | undefined)?.status !== 'accepted' || measurement.catalogStatus === 'rejected';
    update(index, { measurement, status: rejected ? 'rejected' : 'measured' });
  }
  if (c.mode === 'threeStage') for (const [index, region] of samples.entries()) {
    if (rows[index].status === 'rejected') continue;
    c = await read();
    if (ports.fingerprint() !== fingerprint || server.profileVersion !== profileVersion || !server.cameraProfile || !server.displayProfile || server.state !== 'fabric') throw new Error('پروفایل‌ها یا تنظیمات دوربین تغییر کردند؛ تطبیق متوقف شد.');
    const measurement = rows[index].measurement!;
    const id = String(measurement.id ?? measurement.measurementId ?? '');
    if (!id) throw new Error('شناسهٔ واقعی اندازه‌گیری از سرور دریافت نشد.');
    ports.progress(`۴ / تطبیق خودکار نمونه ${index + 1}/${samples.length}: ${region.label}`);
    update(index, { status: 'matching' });
    const match = await wait(() => ports.match(id, region, ports.signal));
    update(index, { match, status: match.status === 'complete' ? 'complete' : 'stopped' });
  }
  ports.progress('صف خودکار تمام شد؛ اعتبار و شکست‌ها فقط طبق پاسخ سرور');
  return rows;
}

export async function runCameraMatchQueue(ports: Omit<LivePorts, 'grid' | 'match'> & { match: (region: Region, frames: Frame[], signal: AbortSignal) => Promise<Record<string, unknown>> }): Promise<LiveItem[]> {
  const wait = <T,>(work: () => Promise<T>) => awaitWithSignal(ports.signal, work);
  let server = await wait(ports.readServer);
  const context = () => ({ ...ports.getContext(), snapshot: server });
  if (context().mode !== 'cameraMatch') throw new Error('تطبیق بدون کارت فقط در قابلیت آزمایشیِ جدا اجرا می‌شود.');
  const requirement = nextLiveRequirement(context()); if (requirement) throw new Error(requirement.text);
  const version = server.profileVersion;
  const fingerprint = ports.fingerprint();
  const samples = fabricRegions(context());
  const rows: LiveItem[] = samples.map(r => ({ regionId: r.id, label: r.label, status: 'queued' })); rows.forEach(ports.item);
  for (const [index, region] of samples.entries()) {
    server = await wait(ports.readServer);
    if (ports.fingerprint() !== fingerprint || server.paused || server.profileVersion !== version) throw new Error('جلسه یا تنظیمات دوربین تغییر کرد؛ تطبیق زنده متوقف شد.');
    rows[index] = { ...rows[index], status: 'capturing' }; ports.item(rows[index]);
    ports.progress(`برداشت خودکار نمونه ${index + 1}/${samples.length}`);
    const [frames] = await wait(() => ports.capture([region], ports.signal));
    rows[index] = { ...rows[index], status: 'matching' }; ports.item(rows[index]);
    const match = await wait(() => ports.match(region, frames, ports.signal));
    rows[index] = { ...rows[index], match, status: match.status === 'complete' ? 'complete' : match.status === 'rejected' ? 'rejected' : 'stopped' }; ports.item(rows[index]);
  }
  ports.progress('صف تطبیق آزمایشی تمام شد؛ رنگ کاتالوگ یا کالیبراسیون فیزیکی تأیید نشده است.');
  return rows;
}
