import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Api, joinUrl, type Credentials, type Mode, type Patch, type Snapshot } from './session';
import { Connection, type Envelope } from './connection';
import { Display } from './Display';
import { Workbench } from './Workbench';
import { cleanConditions, conditionFields, loadStartup, storeStartup } from './startup';
import { ConnectionInfo } from './ConnectionInfo';
import {DiagnosticSync,sendDiagnosticBatch} from './diagnosticSync';
import {diagnosticTrace} from './trace';

export function App({ initialJoin }: { initialJoin: Credentials | null }) {
  const [credentials, setCredentials] = useState(initialJoin);
  const [mode, setMode] = useState<Mode>('threeStage');
  const [connectionOrigin, setConnectionOrigin] = useState(window.location.origin);
  const [archive, setArchive] = useState<Record<string, unknown> | null>(null);
  const [saved] = useState(() => initialJoin ? { conditions: cleanConditions(null), restored: false, notice: '' } : loadStartup());
  const [conditions, setConditions] = useState(saved.conditions);
  const [remember, setRemember] = useState(true); const [reviewNeeded, setReviewNeeded] = useState(saved.restored); const [reviewed, setReviewed] = useState(false); const [storageNotice, setStorageNotice] = useState(saved.notice);
  const [snapshot, setSnapshot] = useState<Snapshot>({ state: 'reference', profileVersion: 0, paused: true });
  const [patch, setPatch] = useState<Patch | null>(null); const [status, setStatus] = useState('disconnected'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [displayLink, setDisplayLink] = useState(''); const [qr, setQr] = useState(''); const [witnessChecked, setWitnessChecked] = useState(false);
  const connection = useRef<Connection | null>(null); const snapshotRef = useRef(snapshot); const patchRef = useRef(patch); const abortRef = useRef<AbortController | null>(null); const wakeHeld = useRef(false);
  snapshotRef.current = snapshot; patchRef.current = patch;
  const pause = (reason: string) => { abortRef.current?.abort(); setSnapshot(s => ({ ...s, paused: true, pauseReason: reason })); setPatch(null); setWitnessChecked(false); connection.current?.send('session.pause', { reason }); };
  useEffect(() => {
    if (!credentials) return;
    const notice = (event: Envelope) => {
      if (event.event === 'session.state') { const state = event.payload as Snapshot; setSnapshot(state); setPatch(state.currentPatch ?? null); if (state.paused) { abortRef.current?.abort(); setWitnessChecked(false); } }
      if (event.event === 'display.patch.set') setPatch(event.payload as unknown as Patch);
      if (event.event === 'display.patch.rendered') setPatch(p => p && p.patchId === event.payload.patchId && p.commandSequence === event.payload.commandSequence ? { ...p, rendered: true } : p);
      if (event.event === 'session.pause' || event.event === 'profile.invalidate') { abortRef.current?.abort(); setSnapshot(s => ({ ...s, paused: true, pauseReason: String(event.payload.reason ?? event.event) })); setPatch(null); setWitnessChecked(false); }
      if (event.event === 'quality.alert' && (event.payload.status === 'rejected' || event.payload.code)) { abortRef.current?.abort(); setError('سرور کیفیت یا عملیات را رد کرد؛ آخرین پاسخ و شرایط را بررسی کنید.'); }
    };
    const displayCapabilities = () => { if (credentials.role === 'display') connection.current?.send('capabilities.report', { browserSupported: true, supportedConstraints: {}, trackCapabilities: {}, requested: {}, reportedSettings: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio }, controlStatus: { brightness: 'unknown', colorMode: 'unknown' }, deviceLabel: 'display A', capturePath: 'css-rgb-single', canvasColorSpace: 'unknown', wakeLock: wakeHeld.current }); };
    const socket = new Connection(credentials, notice, value => { setStatus(value); if (value === 'connected') displayCapabilities(); if (value === 'paused') { abortRef.current?.abort(); setPatch(null); setSnapshot(s => ({ ...s, paused: true, pauseReason: 'socket_disconnected' })); setWitnessChecked(false); } });
    connection.current = socket; socket.connect(window.location.origin);
    const visibility = () => { if (document.visibilityState !== 'visible') pause('page_hidden'); };
    const pagehide = () => pause('page_hidden');
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide);
    let lock: WakeLockSentinel | undefined;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || !navigator.wakeLock) return;
      try { lock = await navigator.wakeLock.request('screen'); wakeHeld.current = true; displayCapabilities(); lock.addEventListener('release', () => { wakeHeld.current = false; displayCapabilities(); if (document.visibilityState === 'visible') void acquire(); else pause('wake_lock_released'); }); }
      catch { setError('قفل بیداری در دسترس نیست؛ روشن‌ماندن صفحه تضمین نمی‌شود.'); }
    }; void acquire();
    return () => { socket.stop(); abortRef.current?.abort(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide); void lock?.release(); };
  }, [credentials]);
  useEffect(()=>{
    if(credentials?.role!=='display'||snapshot.diagnosticsEnabled!==true)return;
    const firstSequence=diagnosticTrace.entries().at(-1)?.sequence??0;
    const sync=new DiagnosticSync(diagnosticTrace,body=>{
      const events=body.events.filter(event=>{
        const evidence=event.details.evidenceSnapshot as {role?:unknown;stage?:unknown}|undefined;
        return event.sequence>firstSequence&&event.event==='evidence'&&evidence?.role==='display'&&evidence.stage==='rendered';
      });
      return events.length?sendDiagnosticBatch(credentials.sessionId,credentials.token,{events}):Promise.resolve({accepted:0});
    });
    sync.start();return()=>sync.stop();
  },[credentials,snapshot.diagnosticsEnabled]);
  const rendered = (payload: Record<string, unknown>) => { connection.current?.send('display.patch.rendered', payload); };
  const forget = () => { setStorageNotice(storeStartup(null)); setConditions(cleanConditions(null)); setReviewNeeded(false); setReviewed(false); };
  const create = async (selectedMode: Mode = mode, explicitFeatureSwitch = false) => {
    if (reviewNeeded && !reviewed && !explicitFeatureSwitch) return;
    setBusy(true); setError('');
    try { const clean = cleanConditions(conditions); const result = await new Api('').create(selectedMode, clean); setMode(selectedMode); setConditions(clean); if (remember) setStorageNotice(storeStartup(clean)); setCredentials({ sessionId: result.sessionId, token: result.cameraToken, role: 'camera' }); setSnapshot({ state: result.state, profileVersion: result.profileVersion, paused: true }); const link = joinUrl(connectionOrigin, result.sessionId, result.displayToken); setDisplayLink(link); setQr(await QRCode.toDataURL(link, { width: 220, margin: 2 })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (credentials?.role === 'display') return <Display patch={patch} paused={snapshot.paused} onRendered={rendered} diagnosticsEnabled={snapshot.diagnosticsEnabled===true} />;
  if (archive) return <main className="lab-shell" dir="rtl"><header className="lab-header"><h1>آرشیو فقط‌خواندنی</h1><p>گزارش قدیمی؛ اتصال زنده، توکن و loop بازیابی نمی‌شود. نسخه‌ها و شکست‌های گزارش همان‌طور باقی می‌مانند.</p></header><pre dir="ltr">{JSON.stringify(archive, null, 2)}</pre><button onClick={() => setArchive(null)}>بازگشت به ایجاد جلسهٔ جدید</button></main>;
  return <main className="lab-shell" dir="rtl">
    <header className="lab-header"><span className="instrument-id" dir="ltr">ARYADECO / COLOR LAB</span><h1>آزمایشگاه رنگ</h1><p>ابزار آزمایشی مستقل · پیکسل مرورگر، نه RAW · دقت فیزیکی مستقل هنوز آزموده نشده</p></header>
    {!credentials ? <section className="panel startup-panel"><h2>چه کاری می‌خواهید انجام دهید؟</h2><div className="toolbar"><button className="primary" disabled={busy || (reviewNeeded && !reviewed)} onClick={() => void create('cameraMatch')}>تطبیق زندهٔ ساده، بدون کارت</button><button disabled={busy || (reviewNeeded && !reviewed)} onClick={() => void create('threeStage')}>اندازه‌گیری کامل با کارت معتبر</button></div><p>تطبیق ساده: دوربین باز می‌ماند، برنامه جای صفحه و نوارهای پارچه را پیدا می‌کند و رنگ صفحه را خودکار تنظیم می‌کند. بدون کارت، این نتیجه آزمایشی است و رنگ تأییدشدهٔ سایت نیست.</p><label>حالت جلسه<select value={mode} onChange={e => setMode(e.target.value as Mode)}><option value="threeStage">سه‌مرحله‌ای: مرجع، نمایشگر، پارچه</option><option value="cameraMatch">تطبیق زندهٔ ساده، بدون کارت (آزمایشی)</option><option value="catalogOnly">فقط کاتالوگ: بدون جبران نمایشگر</option><option value="replay">بازپخش تصویر: همیشه آزمایشی</option></select></label>
      <details><summary>جزئیات شرایط آزمایش (اختیاری)</summary><p>فقط اطلاعاتی را که می‌دانید وارد کنید؛ خالی یعنی نامعلوم، نه مقدار فرضی. موفقیت درخواست تنظیمات به معنی قفل واقعی سخت‌افزار نیست.</p><div className="field-grid">{conditionFields.map(([key, label]) => <label key={key}>{label}<input maxLength={256} value={conditions[key] ?? ''} onChange={e => { setConditions(c => ({ ...c, [key]: e.target.value || null })); setReviewed(false); }} placeholder="نامعلوم" /></label>)}</div></details>
      <label className="check"><input type="checkbox" checked={remember} onChange={e => { setRemember(e.target.checked); if (!e.target.checked) setStorageNotice(storeStartup(null)); }} />حفظ تنظیمات روی همین مرورگر</label><p className="hint">فقط همین هشت توضیح شرایط در زمان شروع حفظ می‌شود؛ توکن، جلسه، پروفایل و کالیبراسیون ذخیره نمی‌شوند.</p>
      {reviewNeeded && <div className="review-notice"><p>تنظیمات قبلی فقط پیش‌نویس هستند؛ جزئیات را برای امروز بازبینی یا پاک کنید. نور، شاهد و قفل دستگاه‌ها دوباره باید بررسی شوند.</p><label className="check"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />شرایط امروز را بازبینی کردم</label></div>}
      <div className="toolbar"><button className="primary" disabled={busy || (reviewNeeded && !reviewed)} onClick={() => void create()}>ایجاد جلسه و شروع</button><button onClick={forget}>فراموش‌کردن تنظیمات این مرورگر</button></div>
      <ConnectionInfo onOrigin={setConnectionOrigin} />
    </section> : <>
      <section className="status-strip"><strong>دوربین B</strong><span>اتصال: {status}</span><span>مرحلهٔ سرور: {snapshot.state}</span><span>نسخهٔ پروفایل: {snapshot.profileVersion}</span><strong className={snapshot.paused ? 'warning' : 'active'}>{snapshot.paused ? `متوقف: ${snapshot.pauseReason ?? 'بررسی شاهد لازم است'}` : 'فعال؛ اعتبار رنگ فقط بر اساس پاسخ سرور'}</strong><div className="toolbar"><button onClick={() => pause('operator_pause')}>توقف جلسه</button><label className="check"><input type="checkbox" checked={witnessChecked} onChange={e => setWitnessChecked(e.target.checked)} />شاهد و شرایط ثابت را بررسی کردم</label><button disabled={!witnessChecked || status !== 'connected'} onClick={() => { connection.current?.send('session.resume', { witnessChecked: true }); }}>ادامه پس از بررسی شاهد</button></div></section>
      {displayLink && <section className="panel join-panel"><div><h2>اتصال نمایشگر A</h2><p>QR حاوی توکن نقش نمایشگر در fragment است؛ آن را به اشتراک عمومی نگذارید. توکن در حافظهٔ این صفحه است و با بارگذاری مجدد دوربین از بین می‌رود.</p><a href={displayLink} target="_blank" rel="noreferrer" aria-label="بازکردن نمایشگر A">بازکردن نمایشگر A</a></div>{qr && <img className="qr" src={qr} alt="QR اتصال نمایشگر A" />}</section>}
      <Workbench key={credentials.sessionId} credentials={credentials} snapshot={snapshot} mode={mode} onChoosePreview={() => { pause('operator_pause'); void create('cameraMatch', true); }} api={new Api(credentials.sessionId, fetch, credentials.token)} send={(event, payload) => connection.current?.send(event, event === 'capabilities.report' ? { ...(payload as Record<string, unknown>), wakeLock: wakeHeld.current } : payload) ?? false} getPatch={() => patchRef.current} pause={pause} onDeleted={() => { connection.current?.stop(); setCredentials(null); setDisplayLink(''); setQr(''); setPatch(null); setSnapshot({ state: 'reference', paused: true, profileVersion: 0 }); }} registerAbort={controller => { abortRef.current = controller; }} refresh={async () => { const state = await new Api(credentials.sessionId, fetch, credentials.token).get(); setSnapshot(state); setPatch(state.currentPatch ?? null); }} />
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    {credentials && <button onClick={forget}>فراموش‌کردن تنظیمات این مرورگر</button>}
    {storageNotice && <p className="hint" role="status">{storageNotice}</p>}
    {!credentials && <section className="panel"><h2>بازبینی گزارش ذخیره‌شده</h2><label>بازبینی خروجی JSON قبلی<input type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 8000000) { setError('گزارش بزرگ‌تر از حد مجاز است.'); return; } void file.text().then(text => { const report = JSON.parse(text); if (!report || typeof report !== 'object' || !Array.isArray(report.measurements)) throw new Error('گزارش خروجی معتبر نیست.'); const clean = JSON.parse(JSON.stringify(report, (key, value) => /token|secret|password/i.test(key) ? undefined : value)); setArchive(clean); }).catch(() => setError('گزارش JSON قابل بازبینی نیست.')); }} /></label><p>فقط بازبینی محلی؛ تصاویر و اتصال فیزیکی جلسهٔ قبلی از گزارش بازسازی نمی‌شوند.</p></section>}
    <footer>قفل دوربین، نور، روشنایی و صحت رنگ دستگاه‌ها تا آزمایش واقعی نامعلوم است.</footer>
  </main>;
}
