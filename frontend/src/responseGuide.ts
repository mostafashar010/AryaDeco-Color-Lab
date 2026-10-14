import { decodeMarker, type Rect } from './marker';
import type { Frame, Region } from './sampling';
import { awaitWithSignal } from './workflow';

export type ResponseCommand = { runId: string; status: string; nextDrive: number[] | null; phase?: 'train' | 'holdout'; step?: number; totalSteps?: number; patchId?: string; commandSequence?: number; responseProfile?: Record<string, unknown> };
export type ResponseGeometry = { screen: Region; card: Region; marker: Rect; referenceRole: 'middle' };
type Context = { fingerprint: string; width: number; height: number; streamId: string };
type Ports = { post: (route: string, body: unknown) => Promise<unknown>; wait: (command: ResponseCommand) => Promise<void>; geometry: () => Promise<ResponseGeometry>; capture: (command: ResponseCommand, geometry: ResponseGeometry) => Promise<Frame[][]>; cancel: (runId: string) => Promise<void>; fingerprint: () => string; context: Context; signal: AbortSignal; progress: (message: string) => void };

export async function runResponseGuide(ports: Ports): Promise<Record<string, unknown>> {
  const wait = <T,>(work: () => Promise<T>) => awaitWithSignal(ports.signal, work);
  let runId = '', complete = false;
  let lastPresented = -1, lastCapturedAt = -1;
  const checkContext = () => { if (ports.fingerprint() !== ports.context.fingerprint) throw new Error('تنظیمات دوربین تغییر کرد؛ پاسخ قبلی معتبر نیست.'); };
  try {
    checkContext();
    let command = await wait(async () => {
      const result = await ports.post('response-profile/start', ports.context) as ResponseCommand;
      runId = result.runId;
      // A late start response still owns a server run, but may never resume this client.
      if (ports.signal.aborted && runId) void ports.cancel(runId).catch(() => {});
      return result;
    });
    let geometry: ResponseGeometry | undefined;
    for (let index = 0; index < 32 && command.status === 'running'; index++) {
      checkContext();
      if (!runId || command.runId !== runId || !command.patchId || !Number.isSafeInteger(command.commandSequence) || command.commandSequence! < 1 || !['train', 'holdout'].includes(command.phase ?? '') || !Array.isArray(command.nextDrive) || command.nextDrive.length !== 3 || command.nextDrive.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('فرمان اندازه‌گیری پاسخ سرور معتبر نیست.');
      ports.progress(`اندازه‌گیری پاسخ نمایشگر: ${command.step ?? index + 1}/${command.totalSteps ?? '?'} · ${command.phase === 'holdout' ? 'اعتبارسنجی مستقل از برازش' : 'برداشت پاسخ'}`);
      await wait(() => ports.wait(command));
      const currentGeometry=await wait(ports.geometry);
      if(geometry&&[geometry.screen,geometry.card].some((region,index)=>{
        const current=[currentGeometry.screen,currentGeometry.card][index];
        return region.id!==current.id||JSON.stringify(region.polygon)!==JSON.stringify(current.polygon)||JSON.stringify(region.exclusions)!==JSON.stringify(current.exclusions);
      }))throw new Error('هندسهٔ صفحه یا همان کارت شاهد تغییر کرد؛ برداشت متوقف شد.');
      geometry=currentGeometry;
      const [frames, cardFrames] = await wait(() => ports.capture(command, geometry!));
      checkContext();
      if (!frames || !cardFrames || frames.length < 10 || frames.length !== cardFrames.length || frames.at(-1)!.capturedAt - frames[0].capturedAt < 1000) throw new Error('۱۰ فریم هم‌زمان صفحه و کارت در حداقل یک ثانیه لازم است.');
      let presented = lastPresented, capturedAt = lastCapturedAt;
      const normalize = (region: Region) => region.polygon.map(([x, y]) => [x / ports.context.width, y / ports.context.height]);
      const expectedRois = [JSON.stringify(normalize(geometry.screen)), JSON.stringify(normalize(geometry.card))];
      const expectedExclusions = [geometry.screen, geometry.card].map(region => JSON.stringify(region.exclusions.map(polygon => polygon.map(([x, y]) => [x / ports.context.width, y / ports.context.height]))));
      for (const [i, frame] of frames.entries()) {
        const card = cardFrames[i];
        if ([frame, card].some((f, j) => JSON.stringify(f.roi) !== expectedRois[j] || JSON.stringify(f.exclusions) !== expectedExclusions[j])) throw new Error('هندسهٔ صفحه یا کارت حین برداشت تغییر کرد.');
        if (!Number.isSafeInteger(frame.presentedFrames) || frame.presentedFrames! <= presented || !Number.isFinite(frame.mediaTime) || frame.mediaTime! < 0 || !Number.isFinite(frame.capturedAt) || frame.capturedAt <= capturedAt || frame.source !== 'videoCanvas' || card.source !== 'videoCanvas' || frame.width !== ports.context.width || frame.height !== ports.context.height || !frame.roi?.length || !card.roi?.length || frame.settingsFingerprint !== ports.context.fingerprint || card.settingsFingerprint !== ports.context.fingerprint || frame.id === card.id || frame.regionId !== geometry.screen.id || card.regionId !== geometry.card.id || ['presentedFrames', 'mediaTime', 'capturedAt', 'width', 'height', 'colorSpace'].some(key => frame[key as keyof Frame] !== card[key as keyof Frame])) throw new Error('هویت یا هندسهٔ برداشت هم‌زمان صفحه و کارت تغییر کرد.');
        if (frame.markerSequence !== command.commandSequence || card.markerSequence !== command.commandSequence || !frame.markerPixels || !card.markerPixels || decodeMarker(frame.markerPixels) !== command.commandSequence || decodeMarker(card.markerPixels) !== command.commandSequence) throw new Error('نشانگر واقعی فرمان جاری در برداشت دیده نشد.');
        presented = frame.presentedFrames!; capturedAt = frame.capturedAt;
      }
      lastPresented = presented; lastCapturedAt = capturedAt;
      command = await wait(async () => await ports.post(`response-profile/${encodeURIComponent(runId)}/observe`, { ...ports.context, commandSequence: command.commandSequence, patchId: command.patchId, phase: command.phase, frames, cardFrames, referenceRole: geometry!.referenceRole }) as ResponseCommand);
    }
    const profile = command.responseProfile;
    if (command.status !== 'complete' || command.nextDrive !== null || !profile || profile.status !== 'cameraReferencedExperimental' || !profile.validation || typeof profile.validation !== 'object' || (profile.validation as Record<string, unknown>).metric !== 'normalizedCameraRgbEuclidean' || !(profile.validation as Record<string, unknown>).holdout) throw new Error('پاسخ نمایشگر هنوز اعتبارسنجی نشده؛ جبران فعال نمی‌شود.');
    checkContext(); complete = true;
    return profile;
  } finally {
    if (!complete && runId) await ports.cancel(runId).catch(() => {});
  }
}
