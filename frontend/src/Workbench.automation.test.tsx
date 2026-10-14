import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Workbench } from './Workbench';
import { Api } from './session';
import { newRegion } from './regions';
import type { Frame, Region } from './sampling';
import type { LiveScene } from './liveScene';
import type { NeutralCards } from './neutralCards';
import type { LiveTracking, LiveTrackerOptions } from './liveTracking';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), grid: vi.fn(), match: vi.fn(), stopped: vi.fn() }));
vi.mock('./liveTracking', () => ({ LiveTracker: class {
  constructor(_video: HTMLVideoElement, private update: (value: LiveTracking) => void, private options: LiveTrackerOptions) {}
  start() { this.publish(); }
  configure(options: Partial<LiveTrackerOptions>) { this.options = { ...this.options, ...options }; this.publish(); }
  stop() {}
  resetBaseline() { setTimeout(()=>this.publish(),0); }
  publish() { this.update({ phase: this.options.phase, status: 'ready', nextAction: 'ثابت', regions: [], marker: null, evidence: { candidateCount: 3, cardCount: 3, fabricCount: 2, neutralCount: 0, markerCandidates: 1, motionSamples: 0, markerSequence: this.options.expectedSequence }, frame: { presentedFrames: 3, mediaTime: 0.3, width: 640, height: 480 }, processingMs: 1, geometryStable: true, moving: false }); }
} }));
vi.mock('./camera', () => ({
  Camera: class { track = { getSettings: () => ({ deviceId: 'rear' }) }; start = vi.fn(async () => ({})); stop = mocks.stopped; fingerprint = () => 'live-settings'; report = () => ({ browserSupported: true }); },
  CapturePipeline: class { capture = mocks.capture; stop = vi.fn(); }, verifyCanvas: () => 'srgb',
}));
vi.mock('./workflow', async importOriginal => ({ ...await importOriginal<typeof import('./workflow')>(), runGrid: mocks.grid, runMatch: mocks.match }));
vi.mock('./RegionEditor', () => ({ RegionEditor: ({ regions, onChange, onMarker, children }: { regions: Region[]; onChange: (r: Region[]) => void; onMarker: (r: unknown) => void; children: React.ReactNode }) => <div>{children}<button>مستطیل</button><button onClick={() => onChange([...regions, { ...newRegion([[0, regions.length * 20], [10, regions.length * 20], [10, regions.length * 20 + 10], [0, regions.length * 20 + 10]], regions.length + 1), id: `roi-${regions.length}`, operatorConfirmed: true }])}>رسم آزمایشی</button><button onClick={() => onChange(regions.map(r => ({ ...r, operatorConfirmed: true })))}>تأیید آزمایشی هندسه</button><button onClick={() => onMarker({ x: 20, y: 0, width: 28, height: 2 })}>نشانگر آزمایشی</button></div> }));
const target = { id: 'real', label: 'physical card', source: 'operator instrument', version: '1', valueType: 'Lab', referenceWhite: 'D50', observer: '2', validity: 'verified', xyzScale: 1, geometry: null, health: null, patches: [{ id: 'neutral', values: [50, 0, 0], split: 'train', neutral: true }] };
async function setup(paused = false, confirmed = true) {
  mocks.capture.mockReset(); mocks.match.mockReset(); mocks.grid.mockReset();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  let state = { state: 'fabric', profileVersion: 5, paused, references: target, cameraProfile: { status: 'referenced' }, displayProfile: { status: 'model-valid' }, capabilities: { display: {} }, measurements: [] as Record<string, unknown>[] };
  const post = vi.fn(async (route: string, body: unknown) => {
    if (route === 'measurements') { const region = (body as { region: Region }).region; const measurement = { id: `m-${region.id}`, region, catalogStatus: 'referenced', captureQuality: 'accepted', quality: { status: 'accepted' }, approved: false }; state = { ...state, measurements: [...state.measurements, measurement] }; return measurement; }
    return {};
  });
  const api = { get: vi.fn(async () => state), post, } as unknown as Api;
  const send = vi.fn((event: string) => { if (event === 'session.resume') state = { ...state, paused: false }; return true; });
  const pause = vi.fn(); const registerAbort = vi.fn();
  const props = { credentials: { sessionId: 's', token: 'secret', role: 'camera' as const }, snapshot: state, mode: 'threeStage' as const, api, send, getPatch: () => ({ patchId: 'p', commandSequence: 1, rendered: true, profileVersion: 5, layout: 'single' as const, displayDriveRgb: [0.5, 0.5, 0.5] as [number, number, number], sampleIds: [] }), pause, registerAbort, refresh: vi.fn() };
  const rendered = render(<Workbench {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'نمایش تنظیمات کامل' }));
  fireEvent.click(screen.getByRole('button', { name: 'فعال‌کردن دوربین B' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('capabilities.report', expect.anything()));
  for (const role of ['نمایشگر A', 'شاهد خنثی', 'کارت مرجع', 'پارچه', 'پارچه']) {
    fireEvent.click(screen.getByRole('button', { name: `${role}: رسم مستطیل` }));
    fireEvent.click(screen.getByRole('button', { name: 'رسم آزمایشی' }));
  }
  if (confirmed) fireEvent.click(screen.getByRole('button', { name: 'تأیید آزمایشی هندسه' }));
  fireEvent.click(screen.getByRole('button', { name: 'نشانگر آزمایشی' }));
  fireEvent.change(screen.getByLabelText('پچ مرجع کارت'), { target: { value: 'neutral' } });
  return { props, rendered, post, send, pause, registerAbort, state: () => state };
}
describe('Workbench automatic live orchestration wiring', () => {
  it.each(['cameraMatch', 'threeStage'] as const)('detects limited neutral cards first in %s without building a full profile', async mode => {
    mocks.capture.mockReset();
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    let state = { state: 'fabric', paused: true, profileVersion: 0, capabilities: { display: {} } };
    const cards: NeutralCards = { status: 'ready', cards: (['dark', 'middle', 'light'] as const).map((role, order) => ({ role, region: { ...newRegion([[order * 30, 0], [order * 30 + 20, 0], [order * 30 + 20, 20], [order * 30, 20]], order), id: `card-${role}`, operatorConfirmed: false, selectionMethod: 'autoDetected' }, observedRgb: [0.2, 0.3, 0.4], confidence: 0.9 })), nextAction: 'ثابت', evidence: { method: 'boundedColorComponentsOrientedGeometry', referenceValues: 'unknown', physicalStandardVerified: false, candidateCount: 3, analysisWidth: 320, analysisHeight: 320, limitations: [] } };
    const scanCards = vi.fn(async () => cards), scanScene = vi.fn();
    const post = vi.fn(async (_route: string, _body: unknown) => ({ status: 'limitedNeutralCheck', referenceValuesKnown: false, fullColorCalibration: false, cameraControlsApplied: false }));
    const api = { get: vi.fn(async () => state), post } as unknown as Api;
    const send = vi.fn((event: string, _payload: unknown) => { if (event === 'session.resume') state = { ...state, paused: false }; return true; });
    mocks.capture.mockImplementation(async (_video, selected: Region[]) => selected.map(r => [{ id: r.id, colorSpace: 'srgb' }] as Frame[]));
    render(<Workbench credentials={{ sessionId: 's', token: 'secret', role: 'camera' }} snapshot={state} mode={mode} api={api} send={send} getPatch={() => null} pause={vi.fn()} registerAbort={vi.fn()} refresh={vi.fn()} scanCards={scanCards} scanScene={scanScene} />);
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' }));
    await screen.findByText('دوربین باز است؛ هنوز اندازه‌گیری شروع نشده');
    expect(screen.getByRole('status', { name: 'اقدام بعدی' })).toHaveTextContent('سه کارت');
    fireEvent.click(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' }));
    fireEvent.click(screen.getByRole('button', { name: mode === 'cameraMatch' ? 'تطبیق دقیق آزمایشی' : 'شروع بررسی همین قاب' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(mocks.capture).toHaveBeenCalledOnce(); expect(mocks.capture.mock.calls[0][1].map((r: Region) => r.id)).toEqual(['card-dark', 'card-middle', 'card-light']);
    expect(post).toHaveBeenCalledWith('neutral-check', expect.objectContaining({ cards: [{ role: 'dark', frames: [{ id: 'card-dark', colorSpace: 'srgb' }] }, { role: 'middle', frames: [{ id: 'card-middle', colorSpace: 'srgb' }] }, { role: 'light', frames: [{ id: 'card-light', colorSpace: 'srgb' }] }] }));
    expect(scanScene).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'اقدام بعدی' })).toHaveTextContent(mode === 'cameraMatch' ? 'پارچه و نمایشگر را کنار هم' : 'مرجع رنگی با مقادیر معتبر');
    expect(post.mock.calls.every(([route]) => route === 'neutral-check')).toBe(true);
    expect(send.mock.calls.some(([event]) => event === 'display.patch.set')).toBe(false);
    if (mode === 'threeStage') expect(screen.queryByRole('button', { name: 'ادامه بدون کارت، آزمایشی' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
  it('opens camera, scans and matches all machine-selected samples without a single manual selection', async () => {
    mocks.capture.mockReset();
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    let state = { state: 'fabric', profileVersion: 0, paused: true, capabilities: { display: {} }, measurements: [] as Record<string, unknown>[] };
    let patch = { patchId: '', commandSequence: 0, profileVersion: 0, displayDriveRgb: [0.5, 0.5, 0.5] as [number, number, number], layout: 'single' as const, sampleIds: [] as string[], rendered: true };
    const auto = (id: string, order: number) => ({ ...newRegion([[order * 20, 0], [order * 20 + 10, 0], [order * 20 + 10, 10], [order * 20, 10]], order), id, source: 'autoDetected' as const, confidence: 0.8, operatorConfirmed: false });
    const scene: LiveScene = { status: 'ready', displayRegion: auto('display', 1), marker: { x: 0, y: 30, width: 112, height: 4 }, fabricRegions: [auto('sample1', 2), auto('sample2', 3)], neutralCandidates: [], nextAction: 'قاب را ثابت نگه دارید.', evidence: { markerCandidates: 1, markerSequence: 1, referenceIdentity: 'unknown', method: 'boundedRasterGeometry', limitations: [] } };
    const scanScene = vi.fn(async () => scene);
    const post = vi.fn(async (route: string) => {
      if (route === 'camera-matches') { patch = { ...patch, patchId: `match-${patch.commandSequence}`, commandSequence: patch.commandSequence + 1 }; return { runId: 'run', measurementId: 'm', status: 'running', nextDrive: [0.3, 0.4, 0.5], patchId: patch.patchId, commandSequence: patch.commandSequence }; }
      return { status: 'complete', nextDrive: null };
    });
    const api = { get: vi.fn(async () => state), post } as unknown as Api;
    const send = vi.fn((event: string, payload: unknown) => { if (event === 'session.resume') state = { ...state, paused: false }; if (event === 'display.patch.set') patch = { ...patch, ...(payload as typeof patch), commandSequence: patch.commandSequence + 1 }; return true; });
    const pause = vi.fn(), registerAbort = vi.fn();
    mocks.capture.mockImplementation(async (_video, selected: Region[]) => selected.map(r => [{ id: r.id, colorSpace: 'srgb' }] as Frame[]));
    render(<Workbench credentials={{ sessionId: 's', token: 'secret', role: 'camera' }} snapshot={state} mode="cameraMatch" api={api} send={send} getPatch={() => patch} pause={pause} registerAbort={registerAbort} refresh={vi.fn()} scanScene={scanScene} />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' }));
    await screen.findByText('دوربین باز است؛ هنوز اندازه‌گیری شروع نشده');
    fireEvent.click(screen.getByRole('button', { name: 'ادامه بدون کارت، آزمایشی' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' }));
    fireEvent.click(screen.getByRole('button', { name: 'تطبیق دقیق آزمایشی' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(screen.getByLabelText('صف نمونه‌های خودکار')).toHaveTextContent('تطبیق تکمیل‌شده: 2'));
    expect(scanScene).toHaveBeenCalledOnce(); expect(pause).toHaveBeenCalledWith('camera_selection_changed');
    expect(mocks.capture.mock.calls.map(call => call[1].map((r: Region) => r.id))).toEqual([['sample1'], ['display', 'sample1'], ['sample2'], ['display', 'sample2']]);
    for (const call of mocks.capture.mock.calls) for (const r of call[1]) { expect(r.operatorConfirmed).toBe(false); expect(r.selectionMethod).toBe('autoDetected'); expect(r).not.toHaveProperty('confidence'); }
    expect(post.mock.calls.every(([route]) => route.startsWith('camera-matches'))).toBe(true);
  });
  it('keeps guided region additions unconfirmed even when an upstream proposal falsely supplies confirmation', async () => {
    await setup(false, false);
    expect(screen.getByRole('status', { name: 'اقدام بعدی' })).toHaveTextContent('شناسایی');
    expect(screen.getByRole('button', { name: 'شروع بررسی همین قاب' })).toBeDisabled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it('runs one finite queue and passes each sample to match capture by closure without shutter actions', async () => {
    const { post, registerAbort } = await setup();
    mocks.capture.mockImplementation(async (_video, selected: Region[], _camera, signal: AbortSignal) => { expect(signal).toBe(registerAbort.mock.calls[0][0].signal); return selected.map(r => [{ id: r.id, colorSpace: 'srgb' }] as Frame[]); });
    mocks.match.mockImplementation(async (_id, ports) => { await ports.capture({ patchId: 'p', commandSequence: 1 }); return { status: 'complete', nextDrive: null }; });
    fireEvent.click(screen.getByRole('button', { name: 'شروع بررسی همین قاب' }));
    await waitFor(() => expect(mocks.match).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText('صف نمونه‌های خودکار')).toHaveTextContent('تطبیق تکمیل‌شده: 2'));
    expect(post.mock.calls.map(([route]) => route)).toEqual(['measurements', 'measurements']);
    expect(mocks.capture.mock.calls.map(call => call[1].map((r: Region) => r.id))).toEqual([['roi-3', 'roi-1', 'roi-2'], ['roi-4', 'roi-1', 'roi-2'], ['roi-0', 'roi-1', 'roi-2', 'roi-3'], ['roi-0', 'roi-1', 'roi-2', 'roi-4']]);
    expect(mocks.grid).not.toHaveBeenCalled();
  });
  it('resumes only after explicit check and real GET then uses fresh server paused state for all captures', async () => {
    const { send } = await setup(true);
    mocks.capture.mockImplementation(async (_v, selected: Region[]) => selected.map(r => [{ id: r.id, colorSpace: 'srgb' }] as Frame[]));
    mocks.match.mockResolvedValue({ status: 'complete' });
    expect(screen.getByRole('button', { name: 'شروع بررسی همین قاب' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' }));
    fireEvent.click(screen.getByRole('button', { name: 'شروع بررسی همین قاب' }));
    await waitFor(() => expect(mocks.match).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.filter(([event]) => event === 'session.resume')).toHaveLength(1);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });
  it('stops during pending REST and does not start another sample after the write resolves', async () => {
    const { post, pause, registerAbort } = await setup();
    mocks.capture.mockImplementation(async (_v, selected: Region[]) => selected.map(r => [{ id: r.id, colorSpace: 'srgb' }] as Frame[]));
    let release!: (value: Record<string, unknown>) => void;
    post.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'شروع بررسی همین قاب' }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'توقف اجرای خودکار' }));
    await waitFor(() => expect(registerAbort.mock.calls[0][0].signal.aborted).toBe(true));
    release({ id: 'late', quality: { status: 'accepted' } });
    await screen.findByRole('alert');
    expect(post).toHaveBeenCalledOnce(); expect(mocks.capture).toHaveBeenCalledOnce(); expect(mocks.match).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
  });
});
