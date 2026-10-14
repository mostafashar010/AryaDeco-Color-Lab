import type { NeutralCards } from './neutralCards';
import type { Frame, Region } from './sampling';
import { awaitWithSignal } from './workflow';

export async function runNeutralGuide(ports: { scan: () => Promise<NeutralCards>; capture: (regions: Region[], signal: AbortSignal) => Promise<Frame[][]>; post: (route: string, body: unknown) => Promise<Record<string, unknown>>; fingerprint: () => string; signal: AbortSignal; overlay: (regions: Region[]) => void }) {
  const wait = <T,>(work: () => Promise<T>) => awaitWithSignal(ports.signal, work);
  const detected = await wait(ports.scan);
  if (detected.status !== 'ready' || detected.cards.length !== 3 || new Set(detected.cards.map(c => c.role)).size !== 3) throw new Error(detected.nextAction);
  const regions = detected.cards.map(c => c.region);
  ports.overlay(regions);
  const batches = await wait(() => ports.capture(regions, ports.signal));
  const report = await wait(() => ports.post('neutral-check', { cards: detected.cards.map((c, index) => ({ role: c.role, frames: batches[index] })), fingerprint: ports.fingerprint() }));
  if (report.status !== 'limitedNeutralCheck' || report.fullColorCalibration !== false || report.referenceValuesKnown !== false) throw new Error('سرور بررسی محدود کارت‌ها را تأیید نکرد؛ مرجع فیزیکی معلوم نیست.');
  return report;
}
