import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbench } from './Workbench';
import type { Api } from './session';
import { TraceLog } from './trace';
import type { LiveTracking, LiveTrackerOptions } from './liveTracking';
import { newRegion } from './regions';
const tracking = vi.hoisted(() => ({ update: undefined as undefined | ((value: LiveTracking) => void), configure: vi.fn(), stop: vi.fn(), start: vi.fn(), resetBaseline:vi.fn(), options: undefined as undefined | LiveTrackerOptions }));
vi.mock('./liveTracking', () => ({ LiveTracker: class {
  constructor(_video: HTMLVideoElement, update: (value: LiveTracking) => void, options: LiveTrackerOptions) { tracking.update = update; tracking.options = options; }
  start = tracking.start; configure = tracking.configure; stop = tracking.stop;resetBaseline=tracking.resetBaseline;
} }));
const detected = (moving = false): LiveTracking => ({ phase: 'cards', status: 'ready', nextAction: 'سه کارت پیدا شد', regions: ['dark', 'middle', 'light'].map((id, i) => ({ ...newRegion([[i * 30, 0], [i * 30 + 20, 0], [i * 30 + 20, 20], [i * 30, 20]], i + 1), id, label: id, selectionMethod: 'autoDetected' })), marker: null, evidence: { candidateCount: 3, cardCount: 3, fabricCount: 0, neutralCount: 0, markerCandidates: 0, motionSamples: 1 }, frame: { presentedFrames: 3, mediaTime: 0.3, width: 640, height: 480 }, processingMs: 20, geometryStable: !moving, moving });

const camera = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), capture: vi.fn(), verify: vi.fn(), ended: undefined as undefined | ((reason: string) => void) }));
vi.mock('./camera', () => ({
  Camera: class {
    constructor(_media: unknown, ended: (reason: string) => void) { camera.ended = ended; }
    track = { getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }) };
    start = camera.start; stop = camera.stop; fingerprint = () => 'settings';
    report = () => ({ reportedSettings: { width: 1920, height: 1080, frameRate: 30 } });
  },
  CapturePipeline: class { capture = camera.capture; stop = vi.fn(); },
  verifyCanvas: camera.verify,
}));
const props = () => ({ credentials: { sessionId: 's', token: 'private-token', role: 'camera' as const }, snapshot: { state: 'fabric', profileVersion: 0, paused: true }, mode: 'cameraMatch' as const, api: { get: vi.fn(), post: vi.fn() } as unknown as Api, send: vi.fn((_event: string, _payload: unknown) => true), pause: vi.fn(), refresh: vi.fn(), registerAbort: vi.fn() });
beforeEach(() => {
  camera.start.mockReset().mockResolvedValue({}); camera.stop.mockClear(); camera.capture.mockReset(); camera.verify.mockClear();
  tracking.start.mockClear(); tracking.configure.mockClear(); tracking.stop.mockClear();tracking.resetBaseline.mockClear();tracking.update = undefined;
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});
describe('visible camera preview before measurement', () => {
  it('resets only the tracking baseline when the user explicitly starts a new scene',async()=>{
    const input=props();vi.mocked(input.api.get).mockResolvedValue({...input.snapshot,paused:false,capabilities:{display:{}}});
    render(<Workbench {...input} getPatch={()=>null}/>);
    fireEvent.click(screen.getByRole('button',{name:'بازکردن دوربین و دیدن کادر'}));await waitFor(()=>expect(tracking.start).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button',{name:'ادامه بدون کارت، آزمایشی'}));
    fireEvent.click(screen.getByRole('checkbox',{name:'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم'}));
    fireEvent.click(screen.getByRole('button',{name:'تطبیق دقیق آزمایشی'}));
    await waitFor(()=>expect(tracking.resetBaseline).toHaveBeenCalledOnce());
    expect(camera.capture).not.toHaveBeenCalled();
  });
  it('does not secretly open a camera when measurement is requested first', async () => {
    const input = props(); render(<Workbench {...input} getPatch={() => null} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' }));
    fireEvent.click(screen.getByRole('button', { name: 'تطبیق دقیق آزمایشی' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('بازکردن دوربین و دیدن کادر');
    expect(camera.start).not.toHaveBeenCalled(); expect(camera.capture).not.toHaveBeenCalled(); expect(input.api.post).not.toHaveBeenCalled();
  });
  it('opens visible native-ratio video without alignment, sampling, float verification or REST requests', async () => {
    const input = props(); const { container } = render(<Workbench {...input} getPatch={() => null} />);
    const button = screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' });
    expect(button).toBeEnabled(); fireEvent.click(button);
    await screen.findByText('دوربین باز است؛ هنوز اندازه‌گیری شروع نشده');
    expect(container.querySelector('video')).toBeVisible();
    expect(screen.getByLabelText('ابعاد گزارش‌شدهٔ دوربین')).toHaveTextContent('1920 × 1080');
    expect(screen.getByLabelText('ابعاد گزارش‌شدهٔ دوربین')).toHaveTextContent('30 fps');
    expect(camera.start).toHaveBeenCalledOnce(); expect(camera.capture).not.toHaveBeenCalled(); expect(camera.verify).not.toHaveBeenCalled();
    expect(input.api.get).not.toHaveBeenCalled(); expect(input.api.post).not.toHaveBeenCalled(); expect(input.send).not.toHaveBeenCalledWith('session.resume', expect.anything());
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
  it('keeps permission failure in the preview panel and releases a stream when video play fails', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValueOnce(new Error('permission denied'));
    render(<Workbench {...props()} getPatch={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' }));
    const alert = await screen.findByRole('alert');
    expect(alert.closest('#lab-capture')).not.toBeNull(); expect(alert).toHaveTextContent('permission denied');
    expect(camera.stop).toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'وضعیت پیش‌نمایش' })).toHaveTextContent('دوربین بسته');
  });
  it('shows ended camera in the preview panel and cleans tracking without a hidden capture', async () => {
    const { act } = await import('@testing-library/react'); const input = props(); render(<Workbench {...input} getPatch={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' }));
    await screen.findByText('دوربین باز است؛ هنوز اندازه‌گیری شروع نشده');
    act(() => camera.ended?.('camera_track_ended'));
    expect(await screen.findByRole('alert')).toHaveTextContent('جریان دوربین پایان یافت');
    expect(screen.getByRole('status', { name: 'وضعیت پیش‌نمایش' })).toHaveTextContent('دوربین بسته');
    expect(tracking.stop).toHaveBeenCalled(); expect(input.pause).toHaveBeenCalledWith('camera_track_ended'); expect(camera.capture).not.toHaveBeenCalled();
  });
  it('releases preview and tracker on pagehide rather than leaving a camera running', async () => {
    const { act } = await import('@testing-library/react'); render(<Workbench {...props()} getPatch={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' })); await waitFor(() => expect(tracking.start).toHaveBeenCalled());
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(camera.stop).toHaveBeenCalled(); expect(tracking.stop).toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'وضعیت پیش‌نمایش' })).toHaveTextContent('دوربین بسته');
  });
  it('exposes redacted trace timeline and download without advanced controls or server export', async () => {
    const trace = new TraceLog(); trace.add('api', 'response', { status: 422, code: 'ambiguous_cards', token: 'private-token' });
    const input = props(); render(<Workbench {...input} getPatch={() => null} trace={trace} />);
    const panel = screen.getByLabelText('عیب‌یابی زنده'); expect(within(panel).getByText(/ambiguous_cards/)).toBeVisible();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const create = vi.fn(() => 'blob:trace'); URL.createObjectURL = create; URL.revokeObjectURL = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: 'دریافت ردگیری JSON' }));
    expect(click).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledOnce(); expect(trace.toJSON()).not.toContain('private-token');
    expect(input.api.get).not.toHaveBeenCalled(); expect(input.api.post).not.toHaveBeenCalled();
  });
  it('tracks idle overlays without measurement and blocks explicit start until three stable detections', async () => {
    const input = props(); render(<Workbench {...input} getPatch={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' }));
    await waitFor(() => expect(tracking.start).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' }));
    expect(screen.getByRole('button', { name: 'تطبیق دقیق آزمایشی' })).toBeDisabled();
    const { act } = await import('@testing-library/react'); act(() => tracking.update?.(detected()));
    expect(screen.getByLabelText('ردیابی ناحیه‌های زنده')).toHaveTextContent('dark');
    expect(screen.getByText(/کارت: 3/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'تطبیق دقیق آزمایشی' })).toBeEnabled();
    expect(camera.capture).not.toHaveBeenCalled(); expect(input.api.post).not.toHaveBeenCalled();
  });
  it('shows partial candidates as unconfirmed without making measurement ready', async () => {
    const { act } = await import('@testing-library/react'); const input = props(); render(<Workbench {...input} getPatch={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' })); await waitFor(() => expect(tracking.start).toHaveBeenCalled());
    act(() => tracking.update?.({ ...detected(), status: 'needsFraming', geometryStable: false, regions: [], candidateRegions: detected().regions.slice(0, 2), debug: { reason: 'missingCards', rejections: { small: 2 }, matchingTriplets: 0 } } as LiveTracking));
    expect(screen.getByLabelText('نامزدهای تأییدنشدهٔ ردیابی')).toHaveTextContent('dark');
    expect(screen.getByText(/رد هندسه: small: 2/)).toHaveTextContent('missingCards'); expect(camera.capture).not.toHaveBeenCalled();
  });
  it('does not erase manual expert geometry when the automatic detector loses the scene',async()=>{
    const {act}=await import('@testing-library/react');render(<Workbench {...props()} getPatch={()=>null}/>);
    fireEvent.click(screen.getByRole('button',{name:'بازکردن دوربین و دیدن کادر'}));await waitFor(()=>expect(tracking.start).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button',{name:'نمایش تنظیمات کامل'}));
    act(()=>tracking.update?.({...detected(true),status:'needsFraming',regions:[]}));
    expect(screen.getByRole('button',{name:'بازگشت به نمای زنده'})).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('keeps preview open when scientific canvas verification fails', async () => {
    const { act } = await import('@testing-library/react'); const input = props();
    vi.mocked(input.api.get).mockResolvedValue({ ...input.snapshot, paused: false });
    camera.verify.mockImplementationOnce(() => { throw new Error('float unavailable'); });
    const scanCards = vi.fn(async () => ({ status: 'ready' as const, cards: detected().regions.map((region, i) => ({ role: (['dark', 'middle', 'light'] as const)[i], region, observedRgb: [0.2, 0.3, 0.4] as [number, number, number], confidence: 0.9 })), nextAction: 'ثابت', evidence: { method: 'boundedColorComponentsOrientedGeometry' as const, referenceValues: 'unknown' as const, physicalStandardVerified: false as const, candidateCount: 3, analysisWidth: 320, analysisHeight: 320, limitations: [] } }));
    render(<Workbench {...input} getPatch={() => null} scanCards={scanCards} />);
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' })); await waitFor(() => expect(tracking.start).toHaveBeenCalled()); act(() => tracking.update?.(detected()));
    fireEvent.click(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' })); fireEvent.click(screen.getByRole('button', { name: 'تطبیق دقیق آزمایشی' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('float unavailable');
    expect(screen.getByRole('status', { name: 'وضعیت پیش‌نمایش' })).toHaveTextContent('دوربین باز'); expect(tracking.stop).not.toHaveBeenCalled(); expect(camera.stop).not.toHaveBeenCalled();
  });
  it('aborts a moving measured frame, keeps tracker preview running and never resumes automatically', async () => {
    const { act } = await import('@testing-library/react'); const input = props();
    vi.mocked(input.api.get).mockResolvedValue({ ...input.snapshot, paused: false });
    const scanCards = vi.fn(async () => ({ status: 'ready' as const, cards: detected().regions.map((region, i) => ({ role: (['dark', 'middle', 'light'] as const)[i], region, observedRgb: [0.2, 0.3, 0.4] as [number, number, number], confidence: 0.9 })), nextAction: 'ثابت', evidence: { method: 'boundedColorComponentsOrientedGeometry' as const, referenceValues: 'unknown' as const, physicalStandardVerified: false as const, candidateCount: 3, analysisWidth: 320, analysisHeight: 320, limitations: [] } }));
    camera.capture.mockImplementation(() => new Promise(() => {}));
    render(<Workbench {...input} getPatch={() => null} scanCards={scanCards} />);
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' }));
    await waitFor(() => expect(tracking.start).toHaveBeenCalledOnce()); act(() => tracking.update?.(detected()));
    fireEvent.click(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' }));
    fireEvent.click(screen.getByRole('button', { name: 'تطبیق دقیق آزمایشی' }));
    await waitFor(() => expect(camera.capture).toHaveBeenCalledOnce());
    const selected = camera.capture.mock.calls[0][1]; const signal = camera.capture.mock.calls[0][3] as AbortSignal;
    expect(input.registerAbort).toHaveBeenCalledWith(expect.objectContaining({ signal }));
    act(() => tracking.update?.({ ...detected(true), regions: detected().regions.map(r => ({ ...r, label: `moved-${r.id}` })) }));
    await waitFor(() => expect(signal.aborted).toBe(true));
    expect(input.pause).toHaveBeenCalledWith('camera_moved'); expect(selected[0].label).toBe('dark');
    expect(screen.getByLabelText('ردیابی ناحیه‌های زنده')).toHaveTextContent('moved-dark');
    expect(tracking.stop).not.toHaveBeenCalled(); expect(camera.stop).not.toHaveBeenCalled();
    act(() => tracking.update?.(detected()));
    expect(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' })).not.toBeChecked();
    expect(camera.capture).toHaveBeenCalledOnce(); expect(input.api.post).not.toHaveBeenCalled();
  });
  it('does not abort initial scene bootstrap while a new command invalidates the previous marker', async () => {
    const { act } = await import('@testing-library/react'); const input = props();
    vi.mocked(input.api.get).mockResolvedValue({ ...input.snapshot, paused: false, capabilities: { display: {} } });
    let patch = { patchId: 'old', commandSequence: 1, rendered: true, profileVersion: 0, displayDriveRgb: [0.5, 0.5, 0.5] as [number, number, number], layout: 'single' as const, sampleIds: [] as string[] };
    input.send.mockImplementation((event: string, payload?: unknown) => { if (event === 'display.patch.set') patch = { ...patch, ...(payload as typeof patch), commandSequence: patch.commandSequence + 1 }; return true; });
    let scanSignal!: AbortSignal;
    const scanScene = vi.fn((_video, _sequence, signal: AbortSignal) => { scanSignal = signal; return new Promise<never>(() => {}); });
    render(<Workbench {...input} getPatch={() => patch} scanScene={scanScene} />);
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' })); await waitFor(() => expect(tracking.start).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'ادامه بدون کارت، آزمایشی' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' }));
    fireEvent.click(screen.getByRole('button', { name: 'تطبیق دقیق آزمایشی' }));
    await waitFor(() => expect(scanScene).toHaveBeenCalled());
    act(() => tracking.update?.({ ...detected(true), phase: 'scene', status: 'needsFraming', regions: [], nextAction: 'marker changed' }));
    expect(scanSignal.aborted).toBe(false); expect(input.pause).not.toHaveBeenCalledWith('camera_moved');
    fireEvent.click(screen.getByRole('button', { name: 'توقف اجرای خودکار' }));
    await waitFor(() => expect(scanSignal.aborted).toBe(true));
  });
});
