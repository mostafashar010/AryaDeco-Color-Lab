import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbench } from './Workbench';
import type { Api, Patch } from './session';
import type { LiveTracking, LiveTrackerOptions } from './liveTracking';
import { markerCells } from './marker';
import type { Frame, Region } from './sampling';
const mocks = vi.hoisted(() => ({ update: undefined as ((value: LiveTracking) => void) | undefined, guide: vi.fn(), relative: vi.fn(),pipelineCreated:vi.fn(),pipelineStopped:vi.fn() }));
vi.mock('./responseGuide', () => ({ runResponseGuide: mocks.guide }));
vi.mock('./liveTracking', () => ({ LiveTracker: class { constructor(_v: unknown, update: (value: LiveTracking) => void, _o: LiveTrackerOptions) { mocks.update = update; } start() {} stop() {} configure() {} resetBaseline() {} } }));
vi.mock('./camera', () => ({ Camera: class { track = { getSettings: () => ({ width: 640, height: 480 }) }; async start() { return {}; } stop() {} fingerprint() { return 'fp'; } report() { return {}; } }, CapturePipeline: class { constructor(){mocks.pipelineCreated();}captureRelative = mocks.relative; stop=mocks.pipelineStopped; }, verifyCanvas: vi.fn() }));
beforeEach(() => {
  mocks.guide.mockReset(); mocks.relative.mockReset();mocks.pipelineCreated.mockClear();mocks.pipelineStopped.mockClear();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 480 });
});
async function setup() {
  let state = { state: 'fabric', profileVersion: 0, paused: true, capabilities: { display: {} } };
  let patch: Patch | null = null;
  const api = { get: vi.fn(async () => state), post: vi.fn(async () => ({})) } as unknown as Api;
  const send = vi.fn((event: string, body: unknown) => {
    if (event === 'session.resume') state = { ...state, paused: false };
    if (event === 'display.patch.set') patch = { ...(body as Patch), commandSequence: (patch?.commandSequence ?? 0) + 1, rendered: true };
    return true;
  });
  const registerAbort = vi.fn(), pause = vi.fn();
  const props = { credentials: { sessionId: 's', token: 'secret', role: 'camera' as const }, snapshot: state, mode: 'cameraMatch' as const, api, send, getPatch: () => patch, pause, registerAbort, refresh: vi.fn() };
  const view = render(<Workbench {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' }));
  await screen.findByText('دوربین باز است؛ هنوز اندازه‌گیری شروع نشده');
  return { api, send, pause, registerAbort, view, props };
}
async function selectManualGeometry(confirm = true, overlap = false) {
  fireEvent.click(screen.getByRole('button', { name: 'تعیین دستی صفحه و کارت' }));
  await screen.findByText(/پچ راه‌اندازی رندر شد/);
  const svg = screen.getByLabelText('ویرایش ناحیه در مختصات اصلی');
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, toJSON() {} });
  const draw = (x: number, y: number, right: number, bottom: number) => {
    fireEvent(svg, new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
    fireEvent(svg, new MouseEvent('pointerup', { bubbles: true, clientX: right, clientY: bottom }));
  };
  fireEvent.click(screen.getByRole('button', { name: 'نمایشگر A: رسم مستطیل' })); draw(60, 50, 200, 210);
  if (confirm) fireEvent.click(screen.getByRole('checkbox', { name: 'هندسه و ترتیب این ناحیه را تأیید می‌کنم' }));
  fireEvent.click(screen.getByRole('button', { name: 'شاهد خنثی: رسم مستطیل' })); draw(overlap ? 150 : 300, 60, overlap ? 250 : 380, 170);
  if (confirm) fireEvent.click(screen.getByRole('checkbox', { name: 'هندسه و ترتیب این ناحیه را تأیید می‌کنم' }));
  fireEvent.click(screen.getByRole('button', { name: 'نشانگر' })); draw(60, 220, 200, 235);
  fireEvent.click(screen.getByRole('checkbox', { name: 'صفحه، کارت و نشانگر انتخاب‌شده و ثابت‌بودن دوربین را تأیید می‌کنم' }));
}
describe('response measurement panel', () => {
  it.each([['unconfirmed', false, false], ['overlap', true, true]] as const)('refuses %s manual geometry before starting a server response run', async (_name, confirmed, overlap) => {
    await setup(); await selectManualGeometry(confirmed, overlap);
    fireEvent.click(screen.getByRole('button', { name: 'اندازه‌گیری پاسخ با ناحیه‌های انتخاب‌شده' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(confirmed ? 'بدون هم‌پوشانی' : 'هندسهٔ هر دو ناحیه');
    expect(mocks.guide).not.toHaveBeenCalled(); expect(mocks.relative).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'wrongMarker', 'witnessDrift'] as const)('keeps real ten-frame guide and server witness validation in manual recovery: %s', async outcome => {
    const f = await setup(); await selectManualGeometry();
    const actual = await vi.importActual<typeof import('./responseGuide')>('./responseGuide');
    mocks.guide.mockImplementation(actual.runResponseGuide);
    const post = vi.mocked(f.api.post);
    post.mockImplementation(async (route: string) => {
      if (route === 'response-profile/start') {
        f.send('display.patch.set', { patchId: 'manual-run', layout: 'single', displayDriveRgb: [.5, .5, .5] });
        return { runId: 'manual', status: 'running', commandSequence: 2, patchId: 'manual-run', phase: 'train', nextDrive: [.5, .5, .5] } as never;
      }
      if (route.endsWith('/observe') && outcome === 'witnessDrift') throw new Error('same witness drift rejected');
      return { status: 'complete', nextDrive: null, responseProfile: { status: 'cameraReferencedExperimental', validation: { metric: 'normalizedCameraRgbEuclidean', holdout: { mean: .003, max: .005 } } } } as never;
    });
    mocks.relative.mockImplementation(async (_video, selected: Region[]) => selected.map((region, index) => Array.from({ length: 10 }, (_, frame): Frame => ({
      id: `${index}-${frame}`, capturedAt: 1000 + frame * 120, presentedFrames: frame + 1, mediaTime: 0, width: 640, height: 480, settingsFingerprint: 'fp', markerSequence: 2, markerPixels: markerCells(outcome === 'wrongMarker' ? 3 : 2).map(bit => [bit, bit, bit]), source: 'videoCanvas', colorSpace: 'srgb', encoding: 'encoded', regionId: region.id, roi: region.polygon.map(([x, y]) => [x / 640, y / 480]), exclusions: [], pixels: Array.from({ length: 16 }, () => [.3, .3, .3]), blockIds: Array.from({ length: 16 }, (_, i) => i), pixelCount: 1000, excludedCount: 0,
    }))));
    fireEvent.click(screen.getByRole('button', { name: 'اندازه‌گیری پاسخ با ناحیه‌های انتخاب‌شده' }));
    if (outcome === 'accepted') {
      await waitFor(() => expect(screen.getByLabelText('وضعیت پاسخ نمایشگر')).toHaveTextContent('مدل آماده'));
      const body = post.mock.calls.find(([route]) => route.endsWith('/observe'))![1] as { frames: Frame[]; cardFrames: Frame[] };
      expect(body.frames).toHaveLength(10); expect(body.cardFrames).toHaveLength(10);
      expect(body.frames[0].roi).toEqual([[60 / 640, 50 / 480], [200 / 640, 50 / 480], [200 / 640, 210 / 480], [60 / 640, 210 / 480]]);
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent(outcome === 'wrongMarker' ? 'نشانگر واقعی' : 'witness drift rejected');
      expect(screen.getByLabelText('وضعیت پاسخ نمایشگر')).not.toHaveTextContent('مدل آماده');
      expect(f.send).toHaveBeenCalledWith('session.pause', { reason: 'operator_pause' });
      if (outcome === 'wrongMarker') expect(post.mock.calls.some(([route]) => route.endsWith('/observe'))).toBe(false);
    }
  });
  it('recovers manual screen and witness without auto geometry while preserving physical capture and cancellation', async () => {
    const f = await setup(); await selectManualGeometry();
    expect(f.send).toHaveBeenCalledWith('session.resume', { witnessChecked: true });
    expect(f.send).toHaveBeenCalledWith('display.patch.set', expect.objectContaining({ layout: 'single', displayDriveRgb: [.5, .5, .5] }));
    let captured = false; let release!: () => void;
    mocks.guide.mockImplementation(async ports => {
      const geometry = await ports.geometry();
      expect(geometry.screen.operatorConfirmed).toBe(true); expect(geometry.card.operatorConfirmed).toBe(true);
      expect(geometry.screen.polygon).toEqual([[60, 50], [200, 50], [200, 210], [60, 210]]);
      expect(geometry.marker).toEqual({ x: 60, y: 220, width: 140, height: 15 });
      await ports.wait({ patchId: f.props.getPatch()!.patchId, commandSequence: 1 });
      mocks.update!({ phase: 'scene', status: 'needsFraming', regions: [], marker: null, nextAction: 'screenNotObserved', geometryStable: false, moving: true, pixelMoving: true, surfaceChanged: true, fresh: true, expectedSequence: 1, frame: { width: 640, height: 480, presentedFrames: 3, mediaTime: 0 }, processingMs: 10, evidence: { candidateCount: 0, cardCount: 0, fabricCount: 0, neutralCount: 0, markerCandidates: 0, motionSamples: 0 } });
      expect(ports.signal.aborted).toBe(false);
      await ports.capture({ patchId: f.props.getPatch()!.patchId, commandSequence: 1 }, geometry);
      captured = true;
      await new Promise<void>(resolve => { release = resolve; });
      return { status: 'cameraReferencedExperimental', validation: { holdout: { mean: .001 } } };
    });
    mocks.relative.mockResolvedValue([[], []]);
    fireEvent.click(screen.getByRole('button', { name: 'اندازه‌گیری پاسخ با ناحیه‌های انتخاب‌شده' }));
    await waitFor(() => expect(captured).toBe(true));
    expect(mocks.relative).toHaveBeenCalledWith(expect.any(HTMLVideoElement), expect.arrayContaining([expect.objectContaining({ operatorConfirmed: true }), expect.objectContaining({ operatorConfirmed: true })]), expect.anything(), expect.any(AbortSignal), { x: 60, y: 220, width: 140, height: 15 }, 1, 'srgb');
    fireEvent.click(screen.getByRole('button', { name: 'توقف اندازه‌گیری پاسخ' }));
    expect(f.registerAbort.mock.calls.at(-1)![0].signal.aborted).toBe(true);
    await act(async () => release());
    expect(screen.getByLabelText('وضعیت پاسخ نمایشگر')).not.toHaveTextContent('مدل آماده');
  });
  it('renders the opt-in live image diagnostic panel beside the real camera preview',async()=>{
    await setup();
    expect(screen.getByRole('region',{name:'عیب‌یابی زنده با تصویر'})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'شروع عیب‌یابی تصویری زنده'})).toBeDisabled();
  });
  it('requires a new manual geometry confirmation after a paused or disconnected session',async()=>{
    const f=await setup();await selectManualGeometry();
    expect(screen.getByRole('checkbox',{name:'صفحه، کارت و نشانگر انتخاب‌شده و ثابت‌بودن دوربین را تأیید می‌کنم'})).toBeChecked();
    f.view.rerender(<Workbench {...f.props} snapshot={{...f.props.snapshot,paused:true,pauseReason:'device_disconnected'}}/>);
    expect(screen.getByRole('checkbox',{name:'صفحه، کارت و نشانگر انتخاب‌شده و ثابت‌بودن دوربین را تأیید می‌کنم'})).not.toBeChecked();
  });
  it('creates a fresh capture worker after the camera is reopened following pagehide',async()=>{
    const f=await setup();
    mocks.guide.mockImplementation(async ports=>{
      const geometry=await ports.geometry();
      await ports.capture(f.props.getPatch()!,geometry);
      return{status:'cameraReferencedExperimental',validation:{holdout:{mean:.003,max:.005}}};
    });
    mocks.relative.mockResolvedValue([[],[]]);
    await selectManualGeometry();fireEvent.click(screen.getByRole('button',{name:'اندازه‌گیری پاسخ با ناحیه‌های انتخاب‌شده'}));
    await waitFor(()=>expect(mocks.relative).toHaveBeenCalledOnce());
    await waitFor(()=>expect(screen.getByLabelText('وضعیت پاسخ نمایشگر')).toHaveTextContent('مدل آماده'));
    expect(mocks.pipelineCreated).toHaveBeenCalledOnce();
    act(()=>window.dispatchEvent(new Event('pagehide')));expect(mocks.pipelineStopped).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button',{name:'بازکردن دوربین و دیدن کادر'}));await screen.findByText('دوربین باز است؛ هنوز اندازه‌گیری شروع نشده');
    await selectManualGeometry();fireEvent.click(screen.getByRole('button',{name:'اندازه‌گیری پاسخ با ناحیه‌های انتخاب‌شده'}));
    await waitFor(()=>expect(mocks.relative).toHaveBeenCalledTimes(2));
    expect(mocks.pipelineCreated).toHaveBeenCalledTimes(2);
  });
  it('allows neutral bootstrap before detector geometry and labels the validated result experimental', async () => {
    await setup();
    mocks.guide.mockResolvedValue({ status: 'cameraReferencedExperimental', validation: { metric: 'normalizedCameraRgbEuclidean', holdout: { mean: .003, max: .005 } } });
    const button = screen.getByRole('button', { name: 'اندازه‌گیری پاسخ نمایشگر' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(mocks.guide).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('وضعیت پاسخ نمایشگر')).toHaveTextContent('جبران پاسخ نمایشگر از دید دوربین، آزمایشی');
    expect(screen.getByLabelText('وضعیت پاسخ نمایشگر')).toHaveTextContent('0.003');
    expect(screen.getByText(/همان کارت خاکستری/)).toBeInTheDocument();
    expect(screen.getByText(/همان کارت خاکستری/)).not.toHaveTextContent('هر سه کارت');
  });
  it('accepts one proposed witness with callback-clock relative stability and no fabric regions',async()=>{
    const f=await setup();
    let patch:Patch|null={patchId:'p1',commandSequence:1,rendered:true,layout:'single',displayDriveRgb:[.5,.5,.5],sampleIds:[],profileVersion:0};
    f.view.rerender(<Workbench {...f.props} getPatch={()=>patch}/>);
    const region=(id:string,x:number)=>({id,label:id,order:0,mode:'solid' as const,polygon:[[x,40],[x+80,40],[x+80,170],[x,170]] as [number,number][],exclusions:[],background:null,layers:null,direction:null,operatorConfirmed:false,selectionMethod:'autoDetected' as const});
    let geometryReturned=false;
    mocks.guide.mockImplementation(async(ports)=>{
      await ports.wait({runId:'r',status:'running',patchId:'p1',commandSequence:1,nextDrive:[.5,.5,.5]});
      mocks.update!({phase:'scene',status:'ready',regions:[region('auto-display',100),region('auto-response-witness',300)],neutralCardRegions:[{role:'middle',region:region('auto-response-witness',300)}],marker:{x:100,y:180,width:112,height:8},nextAction:'شاهد',geometryStable:false,relativeGeometryStable:true,moving:false,pixelMoving:false,surfaceChanged:false,fresh:false,expectedSequence:1,frame:{width:640,height:480,presentedFrames:3,mediaTime:3,timeSource:'callbackClock',reportedMediaTime:0},processingMs:200,evidence:{candidateCount:1,cardCount:0,fabricCount:0,neutralCount:1,markerCandidates:1,markerSequence:1,motionSamples:30}});
      const g=await ports.geometry();geometryReturned=true;
      expect(g.card.id).toBe('auto-response-witness');expect(g.referenceRole).toBe('middle');
      return {status:'cameraReferencedExperimental',validation:{holdout:{mean:.003,max:.005}}};
    });
    fireEvent.click(screen.getByRole('button',{name:'اندازه‌گیری پاسخ نمایشگر'}));
    await waitFor(()=>expect(geometryReturned).toBe(true));
    expect(screen.getByLabelText('وضعیت پاسخ نمایشگر')).toHaveTextContent('مدل آماده');
    patch=null;
  });
  it('stops the bound controller, excludes live preview and never presents a late result as validated', async () => {
    const f = await setup(); let release!: (value: unknown) => void;
    mocks.guide.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'اندازه‌گیری پاسخ نمایشگر' }));
    await waitFor(() => expect(mocks.guide).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'نمایش زندهٔ کالیته' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'تطبیق دقیق آزمایشی' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'توقف اندازه‌گیری پاسخ' }));
    expect(f.registerAbort.mock.calls.at(-1)![0].signal.aborted).toBe(true);
    await act(async () => { release({ status: 'cameraReferencedExperimental', validation: { holdout: { mean: .001 } } }); });
    expect(screen.getByLabelText('وضعیت پاسخ نمایشگر')).not.toHaveTextContent('مدل آماده');
    expect(f.pause).toHaveBeenCalledWith('operator_pause');
  });
  it('aborts on a disconnected session while retaining an explicit unvalidated state', async () => {
    const f = await setup();
    mocks.guide.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))));
    fireEvent.click(screen.getByRole('button', { name: 'اندازه‌گیری پاسخ نمایشگر' }));
    await waitFor(() => expect(mocks.guide).toHaveBeenCalledOnce());
    f.view.rerender(<Workbench {...f.props} snapshot={{ ...f.props.snapshot, paused: true, pauseReason: 'device_disconnected' }} />);
    await waitFor(() => expect(f.registerAbort.mock.calls.at(-1)![0].signal.aborted).toBe(true));
    await waitFor(() => expect(screen.getByLabelText('وضعیت پاسخ نمایشگر')).toHaveTextContent('لغو شد'));
  });
});
