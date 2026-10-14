import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { markerCells } from './marker';
import type { Patch } from './session';
import { diagnosticTrace, type TraceLog } from './trace';

export function Display({ patch, paused, onRendered, trace=diagnosticTrace, diagnosticsEnabled=true }: { patch: Patch | null; paused: boolean; onRendered: (payload: Record<string, unknown>) => void;trace?:TraceLog;diagnosticsEnabled?:boolean }) {
  const acknowledged = useRef('');
  const evidenced=useRef('');
  const [held, setHeld] = useState<Patch | null>(null);
  const [expired, setExpired] = useState(false);
  const expiresAt = useRef(0);
  const ack = useEffectEvent(onRendered);
  const rgbValid = (rgb: number[]) => rgb?.length === 3 && rgb.every(v => Number.isFinite(v) && v >= 0 && v <= 1);
  const bandsValid = patch?.layout === 'liveBands' && patch.bands && patch.bands.length > 0 && patch.bands.length <= 32 && new Set(patch.bands.map(b => b.id)).size === patch.bands.length && patch.bands.every((b, i, all) => b.id && rgbValid(b.drive) && Number.isFinite(b.top) && Number.isFinite(b.bottom) && b.top >= 0 && b.bottom <= 1 && b.top < b.bottom && (i === 0 || b.top >= all[i - 1].bottom));
  const valid = patch && rgbValid(patch.displayDriveRgb) && (patch.layout === 'single' || bandsValid || (patch.layout === 'group' && patch.patches && patch.patches.length <= 32 && patch.patches.length > 0 && patch.patches.every(p => rgbValid(p.drive)))) && Number.isSafeInteger(patch.commandSequence) && patch.commandSequence >= 0 && patch.commandSequence <= 0xffffff;
  const liveKey = valid && patch?.layout === 'liveBands' ? `${patch.profileVersion}:${patch.patchId}:${patch.commandSequence}` : '';
  useEffect(() => {
    if (!liveKey || !patch) return;
    setHeld(patch); setExpired(false); expiresAt.current = Date.now() + 2500;
    const timeout = setTimeout(() => { setHeld(null); setExpired(true); }, Math.max(0, expiresAt.current - Date.now()));
    // A disconnect removes the command, but the original TTL must still finish.
    return () => { clearTimeout(timeout); };
  }, [liveKey]);
  useEffect(() => {
    if (liveKey || !held) return;
    const timeout = setTimeout(() => { setHeld(null); setExpired(true); }, Math.max(0, expiresAt.current - Date.now()));
    return () => clearTimeout(timeout);
  }, [liveKey, held]);
  useEffect(() => {
    if (!valid || paused || !patch || (patch.layout === 'liveBands' && expired)) return;
    const key = `${patch.profileVersion}:${patch.patchId}:${patch.commandSequence}`;
    if (acknowledged.current === key && (!diagnosticsEnabled || evidenced.current===key)) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      if(diagnosticsEnabled){
        const paint=(rgb:number[])=>rgb.map(channel=>Math.round(channel*255)/255);
        const bands=patch.layout==='liveBands'?patch.bands!.map((band,bandIndex)=>({bandIndex,top:band.top,bottom:band.bottom,driveRgb:band.drive,renderedPaintRgb:paint(band.drive)})):patch.layout==='group'?patch.patches!.map((band,bandIndex)=>({bandIndex,driveRgb:band.drive,renderedPaintRgb:paint(band.drive)})):[{bandIndex:0,driveRgb:patch.displayDriveRgb,renderedPaintRgb:paint(patch.displayDriveRgb)}];
        trace.add('preview','evidence',{evidenceSnapshot:{role:'display',stage:'rendered',commandSequence:patch.commandSequence,layout:patch.layout,colorSpace:'srgb',rgbEncoding:'encoded',displayDriveRgb:patch.displayDriveRgb,renderedPaintRgb:paint(patch.displayDriveRgb),bands,renderedProof:'twoAnimationFrames',status:'renderRequestOnly',physicalAccuracyVerified:false}});
        evidenced.current=key;
      }
      if(acknowledged.current!==key){acknowledged.current = key;ack({ profileVersion: patch.profileVersion, patchId: patch.patchId, commandSequence: patch.commandSequence, renderedAt: performance.now() });}
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [patch, paused, valid, expired,diagnosticsEnabled,trace]);
  const live = expired ? null : valid && patch?.layout === 'liveBands' ? patch : (!patch || paused) ? held : null;
  const compensationLabel = live?.compensation?.status === 'measuredFeedbackExperimental' ? `بازخورد اندازه‌گیری‌شدهٔ صفحه، آزمایشی${live.compensation.feedbackApplied === false ? '؛ اصلاح قبلی حفظ شده، بازخورد تازه نرسیده' : ''}` : live?.compensation?.status === 'cameraReferencedExperimental' ? 'جبران مدل پاسخ، بدون بازخورد تازهٔ صفحه، آزمایشی' : live?.compensation?.status === 'partiallyCompensatedExperimental' ? 'جبران مدل فقط برای بعضی نوارها؛ بقیه پیش‌نمایش خام هستند.' : 'RGB دوربین بدون جبران پاسخ نمایشگر';
  if (live) return <main className="display-live" dir="ltr">
    <div data-testid="live-band-domain" className="live-band-domain">{live.bands!.map(b => <div key={b.id} data-testid={`live-band-${b.id}`} className="live-band" style={{ position: 'absolute', top: `${b.top * 100}%`, height: `${Math.round((b.bottom - b.top) * 100000) / 1000}%`, width: '100%', opacity: 1, backgroundColor: `rgb(${b.drive.map(v => Math.round(v * 255)).join(', ')})` }} />)}</div>
    <div className="live-display-footer"><div data-testid="marker" className="command-marker" style={{ flexShrink: 0 }} aria-label="نشانگر دودویی فرمان">{markerCells(live.commandSequence).map((bit, i) => <span key={i} style={{ backgroundColor: bit ? '#fff' : '#000' }} />)}</div><div className="display-readout" dir="rtl" style={{ maxHeight: 40, overflowY: 'auto' }}>{compensationLabel} · فرمان {live.commandSequence} · {live.mapping === 'screenAligned' ? 'هم‌ترازی تخمینی؛ زاویه و پرسپکتیو تأیید نشده' : 'ترتیب نوارها؛ هم‌ترازی هنوز نامعلوم'} · نه تأیید رنگ فیزیکی{paused || !patch ? ' · اتصال متوقف؛ تصویر قبلی موقت است' : ''}{live.compensation?.perBand?.map(band => typeof band.residualBefore === 'number' && Number.isFinite(band.residualBefore) && <span key={band.id} aria-label={`خطای پیش از اصلاح نوار ${band.id}`}> · {band.id}: خطای پیش از اصلاح در RGB دوربین {band.residualBefore.toFixed(4)}{band.saturated ? '؛ محدودیت فرمان' : ''}{band.warnings?.includes('previewFeedbackPlateau') ? '؛ خطا کاهش کافی نداشته' : ''}</span>)}</div></div>
  </main>;
  if (!valid || paused || expired && patch?.layout === 'liveBands') return <main className="display-wait"><h1>نمایشگر A</h1><p>این گوشی را کنار پارچه بگذارید؛ صفحه رو به گوشی دوربین باشد و هر دو کامل در تصویر دیده شوند.</p><p>کارها را فقط روی گوشی دوربین B انجام دهید. روی این گوشی لازم نیست عکس بگیرید یا رنگ انتخاب کنید؛ صفحه خودش تغییر می‌کند.</p><p>{expired ? 'پیش‌نمایش تازه نرسید؛ رنگ قبلی کنار گذاشته شد. اتصال و توقف جلسه را روی گوشی B بررسی کنید.' : paused ? 'منتظر شروع از گوشی دوربین هستم؛ اگر اجرا متوقف شد، پیام همان گوشی را دنبال کنید.' : 'وصل هستم؛ منتظر فرمان گوشی دوربین.'}</p><p>صفحه را باز نگه دارید و گوشی را ثابت بگذارید. روشنایی خودکار و فیلتر شب می‌توانند نتیجه را تغییر دهند؛ کنترل واقعی آن‌ها با برنامه نیست.</p></main>;
  return <main className="display-instrument" dir="ltr">
    <div className="display-readout" dir="rtl">نمایشگر A · فرمان {patch.commandSequence} · تأیید دو فریم مرورگر، نه اثبات رنگ فیزیکی</div>
    {patch.layout === 'single' ? <div data-testid="flat-patch" className="flat-patch" style={{ backgroundColor: `rgb(${patch.displayDriveRgb.map(v => Math.round(v * 255)).join(', ')})`, opacity: 1 }} /> : <><p className="display-readout" dir="rtl">اعتبار گروهی تأیید نشده؛ هیچ ادعای تطبیق هم‌زمان وجود ندارد.</p><div className="group-patches">{patch.patches!.map(p => <div key={p.sampleId}><div data-testid={`group-card-${p.sampleId}`} className="flat-patch group-card" style={{ backgroundColor: `rgb(${p.drive.map(v => Math.round(v * 255)).join(', ')})`, opacity: 1 }} /><span className="display-readout">{p.sampleId}</span></div>)}</div></>}
    <div data-testid="marker" className="command-marker" aria-label="نشانگر دودویی فرمان">{markerCells(patch.commandSequence).map((bit, i) => <span key={i} style={{ backgroundColor: bit ? '#fff' : '#000' }} />)}</div>
    <div className="display-readout" dir="rtl">نشانگر خارج از ناحیهٔ رنگ است. ROI رنگ را از حاشیه و نشانگر جدا نگه دارید.</div>
  </main>;
}
