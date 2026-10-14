import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Workbench } from './Workbench';
import { Api } from './session';
import {TraceLog} from './trace';

const base = { credentials: { sessionId: 's', token: 'camera', role: 'camera' as const }, snapshot: { state: 'reference', profileVersion: 0, paused: false }, send: vi.fn().mockReturnValue(true), getPatch: () => null, pause: vi.fn(), refresh: vi.fn(), registerAbort: vi.fn() };
const render = (ui: React.ReactNode) => { const result = rtlRender(ui); const advanced = screen.queryByRole('button', { name: 'نمایش تنظیمات کامل' }); if (advanced) fireEvent.click(advanced); return result; };
describe('guided live automation view', () => {
  it('does not upload trace history collected before session or before consent re-enable',async()=>{
    vi.useFakeTimers();const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({accepted:1})));vi.stubGlobal('fetch',fetcher);const trace=new TraceLog();trace.add('camera','opened',{width:777});
    const view=rtlRender(<Workbench {...base} snapshot={{...base.snapshot,diagnosticsEnabled:false}} trace={trace} mode="replay" api={new Api('s',fetcher,'camera')}/>);
    trace.add('camera','opened',{width:888});
    view.rerender(<Workbench {...base} snapshot={{...base.snapshot,diagnosticsEnabled:true}} trace={trace} mode="replay" api={new Api('s',fetcher,'camera')}/>);
    trace.add('camera','opened',{width:999});
    try{await vi.advanceTimersByTimeAsync(3000);const upload=fetcher.mock.calls.find(call=>call[1]?.method==='POST');expect(upload).toBeDefined();expect(upload![1].body).toContain('999');expect(upload![1].body).not.toMatch(/777|888/);}finally{view.unmount();vi.useRealTimers();vi.unstubAllGlobals();}
  });
  it('never transmits or polls diagnostics when explicitly disabled',async()=>{
    vi.useFakeTimers();const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const trace=new TraceLog();
    const view=rtlRender(<Workbench {...base} snapshot={{...base.snapshot,diagnosticsEnabled:false}} trace={trace} mode="replay" api={new Api('s',fetcher,'camera')}/>);
    trace.add('tracking','evidence',{evidenceSnapshot:{role:'camera',stage:'rejected'}});
    try{await vi.advanceTimersByTimeAsync(6000);expect(fetcher).not.toHaveBeenCalled();}finally{view.unmount();vi.useRealTimers();vi.unstubAllGlobals();}
  });
  it('defaults to live preview with one missing camera action and hides advanced stages', () => {
    rtlRender(<Workbench {...base} mode="threeStage" api={new Api('s', vi.fn(), 'camera')} />);
    expect(screen.getByRole('heading', { name: 'نمای زنده' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'اقدام بعدی' })).toHaveTextContent('دوربین');
    expect(screen.getByRole('button', { name: 'تشخیص خودکار چیدمان' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'برداشت هم‌زمان پچ‌های مرجع، ۱۰ فریم' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'استخراج ناحیه‌های پارچه' })).not.toBeInTheDocument();
    expect(screen.getByText('کنترل‌های پیشرفته').closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByRole('button', { name: 'شاهد خنثی: رسم مستطیل' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'پارچه: رسم مستطیل' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'مستطیل' })).not.toBeInTheDocument();
  });
  it('does not auto attest or resume a paused initial session', () => {
    const send = vi.fn();
    rtlRender(<Workbench {...base} snapshot={{ ...base.snapshot, paused: true }} send={send} mode="threeStage" api={new Api('s', vi.fn(), 'camera')} />);
    expect(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'شروع بررسی همین قاب' }));
    expect(send).not.toHaveBeenCalled();
  });
  it('preserves explicit replay without exposing an automatic live camera route', () => {
    rtlRender(<Workbench {...base} mode="replay" api={new Api('s', vi.fn(), 'camera')} />);
    expect(screen.queryByRole('button', { name: 'شروع بررسی همین قاب' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('تصویر اصلی برای بازپخش')).toBeInTheDocument();
  });
});
describe('operational reference, replay and export vertical workflow', () => {
  it('navigates visible controls without changing server stage or bypassing capture gates', () => {
    const send = vi.fn();
    render(<Workbench {...base} send={send} snapshot={{ ...base.snapshot, state: 'display', paused: true }} mode="threeStage" api={new Api('s', vi.fn(), 'camera')} />);
    const nav = screen.getByRole('navigation', { name: 'مسیر آزمایش' });
    expect(nav).toHaveTextContent('نمایشگر');
    const current = screen.getByRole('link', { name: '۲. جبران نمایشگر' });
    expect(current).toHaveAttribute('aria-current', 'step');
    for (const link of nav.querySelectorAll('a')) expect(document.getElementById(link.hash.slice(1))).not.toBeNull();
    fireEvent.click(screen.getByRole('link', { name: '۳. پارچه و تطبیق' }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'استخراج ناحیه‌های پارچه' })).toBeDisabled();
    expect(screen.getByText(/همهٔ بخش‌ها در دسترس‌اند/)).toBeInTheDocument();
    expect(screen.getByText(/گوشی B دوربین است/)).toBeInTheDocument();
    expect(screen.getByText(/ROI یعنی ناحیهٔ انتخاب‌شده/)).toBeInTheDocument();
  });
  it('guides replay through image, fabric and report without promising display calibration', () => {
    render(<Workbench {...base} mode="replay" api={new Api('s', vi.fn(), 'camera')} />);
    expect(screen.getByRole('navigation', { name: 'مسیر آزمایش' }).querySelectorAll('a')).toHaveLength(3);
    expect(screen.queryByRole('link', { name: '۲. جبران نمایشگر' })).not.toBeInTheDocument();
    expect(screen.getByText(/بازپخش: تصویر اصلی/)).toBeInTheDocument();
  });
  it('makes exploratory reference explicit then fits only by real backend POST', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'exploratory' })));
    render(<Workbench {...base} mode="catalogOnly" api={new Api('s', fetcher, 'camera')} />);
    fireEvent.click(screen.getByRole('button', { name: 'ثبت مسیر اکتشافی بدون مرجع' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ exploratory: true });
    fireEvent.click(screen.getByRole('button', { name: 'برازش دوربین با برداشت‌های ثبت‌شده' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toBe('/api/sessions/s/camera-profile');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ observations: [] });
    expect(screen.getByText(/قفل دستی واقعی: نامعلوم/)).toBeInTheDocument();
  });
  it('uploads original encoded file only after explicit full-image consent and displays canonical preview', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ captureId: 'capture', width: 864, height: 1536, sourceColorSpace: 'display-p3', colorProvenance: {}, previewUrl: '/api/sessions/s/images/capture/preview' })));
    render(<Workbench {...base} mode="replay" api={new Api('s', fetcher, 'camera')} />);
    const input = screen.getByLabelText('تصویر اصلی برای بازپخش');
    expect(input).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'با ارسال کامل تصویر اصلی به سرور محلی موافقم' }));
    const file = new File(['original bytes'], 'fabric.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    const form = fetcher.mock.calls[0][1].body as FormData;
    expect(form.get('retention')).toBe('false'); expect(form.get('file')).toEqual(file);
    expect(await screen.findByText(/پیش‌نمایش canonical sRGB/)).toBeInTheDocument();
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Content-Type');
  });
  it('exports failure-inclusive experimental report through authenticated GET', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const fetcher = vi.fn().mockResolvedValue(new Response('{"exportKind":"experimental","measurements":[]}'));
    const createUrl = vi.fn(() => 'blob:download'); const revoke = vi.fn();
    const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createUrl; URL.revokeObjectURL = revoke;
    render(<Workbench {...base} mode="replay" api={new Api('s', fetcher, 'camera')} />);
    fireEvent.click(screen.getByRole('button', { name: 'دریافت JSON' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(fetcher.mock.calls[0][0]).toBe('/api/sessions/s/export?format=json&kind=experimental');
    expect(createUrl).toHaveBeenCalled();
    URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;
    click.mockRestore();
  });
  it('manual override appends a provenance-linked version via real endpoint not editing original', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'm2', sourceMeasurementId: 'm1', manualOverride: true, catalogHexSrgb: '#123456', approved: false })));
    render(<Workbench {...base} snapshot={{ ...base.snapshot, measurements: [{ id: 'm1', catalogHexSrgb: '#abcdef', status: 'exploratory' }] }} mode="replay" api={new Api('s', fetcher, 'camera')} />);
    fireEvent.change(screen.getByLabelText('اندازه‌گیری پایهٔ اصلاح دستی'), { target: { value: 'm1' } });
    fireEvent.change(screen.getByLabelText('HEX sRGB دستی'), { target: { value: '#123456' } });
    fireEvent.change(screen.getByLabelText('دلیل اصلاح دستی'), { target: { value: 'operator source' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت نسخهٔ جدید اصلاح دستی' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(fetcher.mock.calls[0][0]).toBe('/api/sessions/s/measurements/m1/override');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ catalogHexSrgb: '#123456', reason: 'operator source' });
    expect(screen.getByText('#abcdef')).toBeInTheDocument();
  });
  it('sends real distinct matched group drives with explicit unverified status', () => {
    const send = vi.fn().mockReturnValue(true);
    render(<Workbench {...base} send={send} snapshot={{ ...base.snapshot, state: 'fabric', measurements: [{ id: 'm1', displayDriveRgb: [1, 0, 0], displayStatus: 'complete' }, { id: 'm2', displayDriveRgb: [0, 1, 0], displayStatus: 'complete' }, { id: 'stopped', displayDriveRgb: [0, 0, 1], displayStatus: 'stopped' }] }} mode="threeStage" api={new Api('s', vi.fn(), 'camera')} />);
    fireEvent.click(screen.getByRole('button', { name: 'نمایش گروهی رنگ‌های تطبیق‌شده، تأییدنشده' }));
    expect(send).toHaveBeenCalledWith('display.patch.set', expect.objectContaining({ layout: 'group', sampleIds: ['m1', 'm2'], patches: [{ sampleId: 'm1', drive: [1, 0, 0] }, { sampleId: 'm2', drive: [0, 1, 0] }] }));
  });
  it('reports catalog and display status separately instead of calling rejected catalog accepted', () => {
    render(<Workbench {...base} snapshot={{ ...base.snapshot, measurements: [{ id: 'outside', catalogStatus: 'rejected', captureQuality: 'accepted', displayStatus: 'notMatched', quality: { status: 'accepted' } }] }} mode="replay" api={new Api('s', vi.fn(), 'camera')} />);
    expect(screen.getByRole('cell', { name: 'rejected' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'notMatched' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'کپی جدول' }));
    expect((screen.getByLabelText('جدول قابل کپی') as HTMLTextAreaElement).value).toContain('rejected');
  });
  it('deletes session without refresh GET and releases local UI session ownership', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); const onDeleted = vi.fn(); const refresh = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Workbench {...base} refresh={refresh} onDeleted={onDeleted} mode="replay" api={new Api('s', fetcher, 'camera')} />);
    fireEvent.click(screen.getByRole('button', { name: 'حذف کامل جلسه و تصاویر' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1].method).toBe('DELETE');
    expect(refresh).not.toHaveBeenCalled(); confirm.mockRestore();
  });
  it('enumerates explicit camera choices before capture without selecting a fallback lens', async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([{ deviceId: 'front', label: 'Explicit camera', kind: 'videoinput' }]) } });
    render(<Workbench {...base} mode="catalogOnly" api={new Api('s', vi.fn(), 'camera')} />);
    fireEvent.click(screen.getByRole('button', { name: 'فهرست دوربین‌ها' }));
    expect(await screen.findByRole('option', { name: 'Explicit camera' })).toBeInTheDocument();
    expect(screen.getByLabelText('دوربین ثابت')).toHaveValue(''); expect(getUserMedia).not.toHaveBeenCalled();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  });
  it('offers real setup command before ROI binding without pretending setup is calibration', () => {
    const send = vi.fn().mockReturnValue(true);
    render(<Workbench {...base} send={send} mode="threeStage" api={new Api('s', vi.fn(), 'camera')} />);
    fireEvent.click(screen.getByRole('button', { name: 'نمایش پچ راه‌اندازی برای تعیین ROI' }));
    expect(send).toHaveBeenCalledWith('display.patch.set', expect.objectContaining({ displayDriveRgb: [0.5, 0.5, 0.5], layout: 'single' }));
  });
});
