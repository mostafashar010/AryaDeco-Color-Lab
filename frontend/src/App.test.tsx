import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { App } from './App';
import {diagnosticTrace} from './trace';

beforeEach(() => localStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const sessionFetch = (fetcher: (path: string, options: RequestInit) => unknown) => vi.stubGlobal('fetch', (path: string, options: RequestInit) => path === '/api/connection-info' ? Promise.resolve(new Response(null, { status: 404 })) : fetcher(path, options));
describe('Persian real-session wizard', () => {
  it('uploads only opted-in rendered display evidence with the display role token',async()=>{
    vi.useFakeTimers();diagnosticTrace.clear();
    let socket:WebSocket;
    class Socket{readyState=1;onmessage?:WebSocket['onmessage'];constructor(){socket=this as unknown as WebSocket;}send(){}close(){}}
    vi.stubGlobal('WebSocket',Socket);
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({accepted:1})));vi.stubGlobal('fetch',fetcher);
    const view=render(<App initialJoin={{sessionId:'display-test',token:'display-only-token',role:'display'}}/>);
    const emit=(enabled:boolean,sequence:number)=>act(()=>socket.onmessage?.call(socket,new MessageEvent('message',{data:JSON.stringify({event:'session.state',protocolVersion:1,sessionId:'display-test',sequenceId:sequence,role:'server',payload:{state:'fabric',paused:false,profileVersion:0,diagnosticsEnabled:enabled}})})));
    const log=()=>diagnosticTrace.add('preview','evidence',{evidenceSnapshot:{role:'display',stage:'rendered',commandSequence:3,renderedProof:'twoAnimationFrames',physicalAccuracyVerified:false,colorSpace:'srgb',rgbEncoding:'encoded',renderedPaintRgb:[0,0,0]}});
    try{
      log();await act(async()=>{await vi.advanceTimersByTimeAsync(3100);});expect(fetcher).not.toHaveBeenCalled();
      emit(true,1);log();await act(async()=>{await vi.advanceTimersByTimeAsync(3100);});
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0][0]).toBe('/api/sessions/display-test/diagnostics');
      expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer display-only-token');
      const body=JSON.parse(fetcher.mock.calls[0][1].body);expect(body.events).toHaveLength(1);expect(body.events[0].details.evidenceSnapshot.stage).toBe('rendered');
      emit(false,2);log();await act(async()=>{await vi.advanceTimersByTimeAsync(3100);});expect(fetcher).toHaveBeenCalledOnce();
    }finally{view.unmount();vi.useRealTimers();diagnosticTrace.clear();}
  });
  it('switches full mode to an explicitly new experimental session without relabelling the old profile',async()=>{
    const fetcher=vi.fn().mockImplementation((_url:string,init:RequestInit)=>Promise.resolve(new Response(JSON.stringify({sessionId:fetcher.mock.calls.length===1?'full-old':'preview-new',cameraToken:'c',displayToken:'d',state:JSON.parse(init.body as string).mode==='cameraMatch'?'fabric':'reference',profileVersion:0}))));
    sessionFetch(fetcher);class Socket{readyState=0;close(){}}vi.stubGlobal('WebSocket',Socket);
    render(<App initialJoin={null}/>);fireEvent.click(screen.getByRole('button',{name:'اندازه‌گیری کامل با کارت معتبر'}));
    await screen.findByText('دوربین B');fireEvent.click(screen.getByRole('button',{name:'نمایش زندهٔ کالیته آزمایشی'}));
    await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetcher.mock.calls[1][1].body as string).mode).toBe('cameraMatch');
    await waitFor(()=>expect(screen.getByRole('link',{name:'بازکردن نمایشگر A'}).getAttribute('href')).toContain('preview-new'));
    expect(screen.getByRole('link',{name:'بازکردن نمایشگر A'}).getAttribute('href')).toContain('preview-new');
  });
  it('starts the explicit no-card live feature with one action, never claims full calibration', async () => {
    const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('connection-info') ? { origin: location.origin, https: false, publicCaAvailable: false, phoneSetupUrl: '/phone-setup' } : { sessionId: 'fast', cameraToken: 'c', displayToken: 'd', state: 'fabric', profileVersion: 0 }))));
    vi.stubGlobal('fetch', fetcher);
    class Socket { readyState = 0; close() {} }
    vi.stubGlobal('WebSocket', Socket);
    render(<App initialJoin={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'تطبیق زندهٔ ساده، بدون کارت' }));
    await waitFor(() => expect(fetcher.mock.calls.some(call => call[1]?.method === 'POST')).toBe(true));
    const posted = fetcher.mock.calls.find(call => call[1]?.method === 'POST');
    expect(JSON.parse(posted![1].body).mode).toBe('cameraMatch');
  });
  it('uses the server-provided reachable origin for the display link without blocking startup on connection info', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path === '/api/connection-info' ? { origin: 'https://192.168.8.8:8443', https: true, phoneSetupUrl: '/phone-setup', publicCaAvailable: true } : { sessionId: 's1', cameraToken: 'c', displayToken: 'd', state: 'reference', profileVersion: 0 })))));
    class Socket { readyState = 0; close() {} }
    vi.stubGlobal('WebSocket', Socket);
    render(<App initialJoin={null} />);
    expect(await screen.findByText('https://192.168.8.8:8443')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ایجاد جلسه و شروع' }));
    expect((await screen.findByRole('link', { name: 'بازکردن نمایشگر A' })).getAttribute('href')).toBe('https://192.168.8.8:8443/display#session=s1&token=d');
  });
  it('forgets only startup settings even during a session and does not require review for empty saved conditions', async () => {
    localStorage.setItem('colorlab.startup.v1', JSON.stringify({ version: 1, conditions: { illumination: 'old light' } }));
    localStorage.setItem('measurement-session', 'keep-this-report');
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ sessionId: 's1', cameraToken: 'c', displayToken: 'd', state: 'reference', profileVersion: 0 }))));
    sessionFetch(fetcher);
    class Socket { readyState = 0; close() {} }
    vi.stubGlobal('WebSocket', Socket);
    const view = render(<App initialJoin={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'فراموش‌کردن تنظیمات این مرورگر' }));
    expect(localStorage.getItem('colorlab.startup.v1')).toBeNull();
    expect(localStorage.getItem('measurement-session')).toBe('keep-this-report');
    expect(screen.getByLabelText('نور محیط')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'ایجاد جلسه و شروع' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'ایجاد جلسه و شروع' }));
    await screen.findByText('دوربین B');
    fireEvent.click(screen.getByRole('button', { name: 'فراموش‌کردن تنظیمات این مرورگر' }));
    expect(screen.getByText('دوربین B')).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('measurement-session')).toBe('keep-this-report');
    view.unmount();
    localStorage.setItem('colorlab.startup.v1', JSON.stringify({ version: 1, conditions: { illumination: null } }));
    render(<App initialJoin={null} />);
    expect(screen.queryByLabelText('شرایط امروز را بازبینی کردم')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ایجاد جلسه و شروع' })).toBeEnabled();
  });
  it('offers a collapsed optional form with no required inputs and opting out removes saved defaults without clearing the draft', () => {
    const { container } = render(<App initialJoin={null} />);
    const details = screen.getByText('جزئیات شرایط آزمایش (اختیاری)').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(container.querySelector('[required]')).toBeNull();
    expect(details?.querySelectorAll('input')).toHaveLength(8);
    fireEvent.change(screen.getByLabelText('نور محیط'), { target: { value: 'draft' } });
    localStorage.setItem('colorlab.startup.v1', '{}');
    fireEvent.click(screen.getByLabelText('حفظ تنظیمات روی همین مرورگر'));
    expect(localStorage.getItem('colorlab.startup.v1')).toBeNull();
    expect(screen.getByLabelText('نور محیط')).toHaveValue('draft');
    expect(screen.getByLabelText('حفظ تنظیمات روی همین مرورگر')).not.toBeChecked();
  });
  it('remembers editable conditions on this browser and requires review after reload, never restoring mode or credentials', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ sessionId: 's1', cameraToken: 'camera-secret', displayToken: 'display-secret', state: 'reference', profileVersion: 0 }))));
    sessionFetch(fetcher);
    class Socket { readyState = 0; close() {} }
    vi.stubGlobal('WebSocket', Socket);
    const first = render(<App initialJoin={null} />);
    expect(screen.getByLabelText('حفظ تنظیمات روی همین مرورگر')).toBeChecked();
    fireEvent.change(screen.getByLabelText('نور محیط'), { target: { value: '  نور کنار پنجره  ' } });
    fireEvent.change(screen.getByLabelText('حالت جلسه'), { target: { value: 'catalogOnly' } });
    fireEvent.click(screen.getByRole('button', { name: 'ایجاد جلسه و شروع' }));
    await screen.findByText('دوربین B');
    expect(JSON.parse(fetcher.mock.calls[0][1].body).conditions.illumination).toBe('نور کنار پنجره');
    first.unmount();
    render(<App initialJoin={null} />);
    expect(screen.getByLabelText('حالت جلسه')).toHaveValue('threeStage');
    expect(screen.getByLabelText('نور محیط')).toHaveValue('نور کنار پنجره');
    expect(screen.getByText(/تنظیمات قبلی فقط پیش‌نویس/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ایجاد جلسه و شروع' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('نور محیط'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('شرایط امروز را بازبینی کردم'));
    fireEvent.click(screen.getByRole('button', { name: 'ایجاد جلسه و شروع' }));
    await screen.findByText('دوربین B');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ mode: 'threeStage', conditions: { illumination: null, cameraModel: null } });
    const saved = localStorage.getItem('colorlab.startup.v1')!;
    expect(JSON.parse(saved)).toMatchObject({ version: 1, conditions: { illumination: null } });
    expect(saved).not.toMatch(/camera-secret|display-secret|"token"|"profile"|"calibration"|"mode"|"sessionId"/i);
  });
  it('starts unknown with explicit modes and sends real session POST on operator action', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: 's1', cameraToken: 'c', displayToken: 'd', state: 'reference', profileVersion: 0 })));
    sessionFetch(fetcher);
    class Socket { readyState = 0; close() {} }
    vi.stubGlobal('WebSocket', Socket);
    render(<App initialJoin={null} />);
    expect(screen.getByRole('heading', { name: 'آزمایشگاه رنگ' })).toBeInTheDocument();
    expect(screen.getByLabelText('حالت جلسه')).toHaveValue('threeStage');
    expect(screen.getByLabelText('نور محیط')).toHaveValue('');
    expect(screen.getByText(/پیکسل مرورگر، نه RAW/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('حالت جلسه'), { target: { value: 'catalogOnly' } });
    fireEvent.click(screen.getByRole('button', { name: 'ایجاد جلسه و شروع' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ mode: 'catalogOnly', conditions: { illumination: null } });
    expect(await screen.findByText('دوربین B')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'بازکردن نمایشگر A' }).getAttribute('href')).toContain('/display#session=s1&token=d');
    expect(screen.getByRole('button', { name: 'ادامه پس از بررسی شاهد' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'نمایش تنظیمات کامل' }));
    expect(screen.getByRole('button', { name: 'ثبت مسیر اکتشافی بدون مرجع' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'دریافت JSON' })).toBeInTheDocument();
  });
  it('scrubbed display credentials never request camera endpoints', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    class Socket { readyState = 0; close() {} }
    vi.stubGlobal('WebSocket', Socket);
    render(<App initialJoin={{ sessionId: 's', token: 'secret', role: 'display' }} />);
    expect(screen.getByRole('heading', { name: 'نمایشگر A' })).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('imports exported JSON only as an archived read-only report with no socket or capture', async () => {
    const fetcher = vi.fn(); sessionFetch(fetcher); const socket = vi.fn(); vi.stubGlobal('WebSocket', socket);
    render(<App initialJoin={null} />);
    const report = { exportKind: 'experimental', sessionId: 'old', profileVersion: 7, measurements: [{ id: 'failed', status: 'rejected' }], cameraToken: 'must-not-retain' };
    const file = new File([JSON.stringify(report)], 'export.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(report) });
    fireEvent.change(screen.getByLabelText('بازبینی خروجی JSON قبلی'), { target: { files: [file] } });
    expect(await screen.findByText(/آرشیو فقط‌خواندنی/)).toBeInTheDocument();
    expect(screen.getByText(/failed/)).toBeInTheDocument();
    expect(socket).not.toHaveBeenCalled(); expect(fetcher.mock.calls.every(([path]) => path === '/api/connection-info')).toBe(true);
    expect(screen.queryByText(/must-not-retain/)).not.toBeInTheDocument();
  });
  it('pauses on hidden document and records actual display wake lock without claiming physical controls', async () => {
    const sent: string[] = []; let socket!: { onopen?: () => void; onmessage?: (e: { data: string }) => void };
    class Socket { readyState = 1; onopen?: () => void; onmessage?: (e: { data: string }) => void; constructor() { socket = this; } send(data: string) { sent.push(data); } close() {} }
    vi.stubGlobal('WebSocket', Socket);
    const lock = { addEventListener: vi.fn(), release: vi.fn() };
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: vi.fn().mockResolvedValue(lock) } });
    render(<App initialJoin={{ sessionId: 's', token: 't', role: 'display' }} />);
    socket.onopen!();
    await waitFor(() => expect(sent.some(raw => JSON.parse(raw).event === 'capabilities.report' && JSON.parse(raw).payload.wakeLock === true)).toBe(true));
    expect(sent.map(raw => JSON.parse(raw)).filter(e => e.event === 'capabilities.report').at(-1).payload).toMatchObject({ wakeLock: true, controlStatus: { brightness: 'unknown' } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));
    expect(sent.map(raw => JSON.parse(raw)).at(-1)).toMatchObject({ event: 'session.pause', payload: { reason: 'page_hidden' } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
  });
  it('does not mislabel accepted quality notices as rejected or echo server pause', async () => {
    const sent: string[] = []; let socket!: { onopen?: () => void; onmessage?: (e: { data: string }) => void };
    class Socket { readyState = 1; onopen?: () => void; onmessage?: (e: { data: string }) => void; constructor() { socket = this; } send(data: string) { sent.push(data); } close() {} }
    vi.stubGlobal('WebSocket', Socket);
    sessionFetch(vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: 's', cameraToken: 'c', displayToken: 'd', state: 'reference', profileVersion: 0 }))));
    render(<App initialJoin={null} />); fireEvent.click(screen.getByRole('button', { name: 'ایجاد جلسه و شروع' }));
    await screen.findByText('دوربین B');await waitFor(()=>expect(socket).toBeDefined()); act(() => socket.onopen!());
    const notice = (event: string, payload: Record<string, unknown>, sequenceId: number) => JSON.stringify({ event, payload, sequenceId, role: 'server', protocolVersion: 1, sessionId: 's', messageId: `m${sequenceId}` });
    act(() => socket.onmessage!({ data: notice('quality.alert', { status: 'accepted' }, 1) }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => socket.onmessage!({ data: notice('session.pause', { reason: 'remote_pause' }, 2) }));
    expect(sent.map(raw => JSON.parse(raw)).filter(e => e.event === 'session.pause')).toHaveLength(0);
  });
});
