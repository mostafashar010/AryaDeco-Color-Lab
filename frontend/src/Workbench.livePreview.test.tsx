import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbench, LivePreviewPump } from './Workbench';
import type { Api, LivePreviewInput, Patch } from './session';
import type { LiveTracking, LiveTrackerOptions } from './liveTracking';
import { markerCells } from './marker';
import {TraceLog} from './trace';
const tracker = vi.hoisted(() => ({ update: undefined as ((value: LiveTracking) => void) | undefined, options: undefined as LiveTrackerOptions | undefined, configure: vi.fn(), stop: vi.fn() }));
vi.mock('./liveTracking', () => ({ LiveTracker: class {
  constructor(_video: HTMLVideoElement, update: (value: LiveTracking) => void, options: LiveTrackerOptions) { tracker.update = update; tracker.options = options; }
  start() {} configure = tracker.configure; stop = tracker.stop; resetBaseline() {}
} }));
vi.mock('./camera', () => ({ Camera: class { track = { getSettings: () => ({ width: 640, height: 480 }) }; async start() { return {}; } stop() {} fingerprint() { return 'settings'; } report() { return {}; } }, CapturePipeline: class {}, verifyCanvas: vi.fn() }));
const input = (n: number): LivePreviewInput => ({ streamId: 'abcdefghijklmnop', bands: [{ id: `b${n}`, drive: [0.2, 0.3, 0.4], top: 0, bottom: 1 }], mapping: 'orderedPreview', sourceFrame: { presentedFrames: n, mediaTime: n / 10, width: 640, height: 480 }, warnings: [] });
const patch = (n: number): Patch => ({ profileVersion: 0, patchId: `p${n}`, commandSequence: n, displayDriveRgb: [0.5, 0.5, 0.5], layout: 'liveBands', sampleIds: [], bands: input(n).bands });
beforeEach(() => {
  tracker.configure.mockClear(); tracker.stop.mockClear(); tracker.update = undefined;
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { configurable: true, value: vi.fn((callback: VideoFrameRequestCallback) => { queueMicrotask(() => callback(performance.now(), { presentedFrames: 1, mediaTime: 0.01 } as VideoFrameCallbackMetadata)); return 1; }) });
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 480 });
});
afterEach(() => vi.useRealTimers());
describe('latest-only live preview commands', () => {
  it('holds identical targets long enough for a delayed camera to observe the command before sending feedback', async () => {
    vi.useFakeTimers(); let sequence = 0;
    const post = vi.fn(async (_body: LivePreviewInput) => patch(++sequence));
    const pump = new LivePreviewPump(post, vi.fn(), vi.fn());
    const stable = (n: number): LivePreviewInput => ({ ...input(n), bands: input(1).bands });
    pump.update(stable(1)); await vi.advanceTimersByTimeAsync(500);
    pump.update(stable(2)); await vi.advanceTimersByTimeAsync(500);
    pump.update(stable(3)); await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledOnce();
    pump.update({ ...stable(4), feedback: { commandSequence: 1, patchId: 'p1', stable: true, markerPixels: markerCells(1).map(bit => [bit, bit, bit]), screenRoi: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.8], [0.1, 0.8]], screenAppearanceBands: [{ id: 'b1', rgb: [0.1, 0.2, 0.3], validPixels: 100, validBlocks: 9, blockSpread: 0.01, clippedRate: 0 }] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(2); expect(post.mock.calls[1][0].feedback?.commandSequence).toBe(1);
    await vi.advanceTimersByTimeAsync(500); pump.update(stable(5)); await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(2); pump.stop();
  });
  it('refreshes identical targets from a newer actual frame at 1500ms without replaying suppressed frames', async () => {
    vi.useFakeTimers(); const post = vi.fn(async (body: LivePreviewInput) => patch(body.sourceFrame.presentedFrames));
    const pump = new LivePreviewPump(post, vi.fn(), vi.fn());
    const stable = (n: number): LivePreviewInput => ({ ...input(n), bands: input(1).bands });
    pump.update(stable(1)); await vi.advanceTimersByTimeAsync(1499);
    pump.update(stable(2)); await vi.advanceTimersByTimeAsync(0); expect(post).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(post).toHaveBeenCalledOnce();
    pump.update(stable(3)); await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(2); expect(post.mock.calls[1][0].sourceFrame.presentedFrames).toBe(3);
    pump.stop();
  });
  it('holds the command when queued feedback becomes stale before the next send', async () => {
    vi.useFakeTimers(); let feedbackCurrent = true;
    const post = vi.fn(async (body: LivePreviewInput) => patch(body.sourceFrame.presentedFrames));
    const pump = new LivePreviewPump(post, vi.fn(), vi.fn(), body => {
      if (feedbackCurrent) return body;
      const { feedback: _feedback, ...target } = body; return target;
    });
    pump.update(input(1)); await vi.advanceTimersByTimeAsync(0);
    pump.update({ ...input(2), bands: input(1).bands, feedback: { commandSequence: 1, patchId: 'p1', stable: true, markerPixels: markerCells(1).map(bit => [bit, bit, bit]), screenRoi: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.8], [0.1, 0.8]], screenAppearanceBands: [{ id: 'b1', rgb: [0.1, 0.2, 0.3], validPixels: 100, validBlocks: 9, blockSpread: 0.01, clippedRate: 0 }] } });
    feedbackCurrent = false; await vi.advanceTimersByTimeAsync(500);
    expect(post).toHaveBeenCalledOnce(); pump.stop();
  });
  it('suppresses the identical in-flight backlog but immediately sends actual color layout and mapping changes within 2Hz', async () => {
    vi.useFakeTimers(); let release!: (patch: Patch) => void;
    const post = vi.fn((_body: LivePreviewInput) => new Promise<Patch>(resolve => { release = resolve; }));
    const pump = new LivePreviewPump(post, vi.fn(), vi.fn());
    const stable = (n: number): LivePreviewInput => ({ ...input(n), bands: input(1).bands });
    pump.update(stable(1)); pump.update(stable(2));
    await vi.advanceTimersByTimeAsync(700); release(patch(1)); await vi.advanceTimersByTimeAsync(500);
    expect(post).toHaveBeenCalledOnce();
    const changed = { ...stable(3), bands: [{ ...input(1).bands[0], drive: [0.21, 0.3, 0.4] as [number, number, number] }] };
    pump.update(changed); expect(post).toHaveBeenCalledTimes(2);
    release(patch(2)); await vi.advanceTimersByTimeAsync(500);
    pump.update({ ...changed, sourceFrame: input(4).sourceFrame, bands: [{ ...changed.bands[0], top: 0.1 }] }); expect(post).toHaveBeenCalledTimes(3);
    release(patch(3)); await vi.advanceTimersByTimeAsync(500);
    pump.update({ ...changed, sourceFrame: input(5).sourceFrame, bands: [{ ...changed.bands[0], top: 0.1 }], mapping: 'screenAligned' }); expect(post).toHaveBeenCalledTimes(4);
    pump.stop();
  });
  it('does not substitute a neutral locator while detector keeps reporting actual empty frames', async () => {
    vi.useFakeTimers(); const post = vi.fn(async (body: LivePreviewInput) => patch(body.sourceFrame.presentedFrames));
    const pump = new LivePreviewPump(post, vi.fn(), vi.fn());
    pump.update(input(1)); await vi.advanceTimersByTimeAsync(2000);
    pump.update({ ...input(2), bands: [] });
    pump.heartbeat(input(3).sourceFrame, input(3).streamId); await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledOnce(); pump.stop();
  });
  it('waits for an actual frame after a feedback conflict instead of replaying queued evidence or stopping', async () => {
    vi.useFakeTimers(); let reject!: (reason: unknown) => void;
    const failed = vi.fn(), post = vi.fn((body: LivePreviewInput) => post.mock.calls.length === 1 ? new Promise<Patch>((_resolve, no) => { reject = no; }) : Promise.resolve(patch(body.sourceFrame.presentedFrames)));
    const pump = new LivePreviewPump(post, vi.fn(), failed);
    pump.update(input(1)); pump.update(input(2));
    reject(Object.assign(new Error('changed command'), { status: 409, code: 'preview_feedback_stale_command' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(failed).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledOnce();
    pump.update(input(2)); await vi.advanceTimersByTimeAsync(0); expect(post).toHaveBeenCalledOnce();
    pump.update(input(3)); await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(2); expect(post.mock.calls[1][0]).toEqual(input(3)); pump.stop();
  });
  it('keeps only a neutral locator alive from new camera frames when detector results are late', async () => {
    vi.useFakeTimers(); const post = vi.fn(async (body: LivePreviewInput) => patch(body.sourceFrame.presentedFrames));
    const pump = new LivePreviewPump(post, vi.fn(), vi.fn());
    pump.update(input(1)); await vi.advanceTimersByTimeAsync(1900);
    pump.heartbeat(input(2).sourceFrame, input(2).streamId);
    expect(post).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100); pump.heartbeat(input(3).sourceFrame, input(3).streamId);
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0]).toMatchObject({ bands: [{ id: 'locator', drive: [0.5, 0.5, 0.5], top: 0, bottom: 1 }], sourceFrame: input(3).sourceFrame });
    await vi.advanceTimersByTimeAsync(1000); pump.heartbeat(input(3).sourceFrame, input(3).streamId); await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(2);
    pump.heartbeat(input(4).sourceFrame, input(4).streamId); await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(3);
    pump.update(input(2)); await vi.advanceTimersByTimeAsync(1000); expect(post).toHaveBeenCalledTimes(3);
    pump.stop(); pump.heartbeat(input(5).sourceFrame, input(5).streamId); await vi.advanceTimersByTimeAsync(3000); expect(post).toHaveBeenCalledTimes(3);
  });
  it('does not invent advancing media time when fresh camera frame counters advance with a frozen clock', async () => {
    vi.useFakeTimers(); const post = vi.fn(async (body: LivePreviewInput) => patch(body.sourceFrame.presentedFrames));
    const pump = new LivePreviewPump(post, vi.fn(), vi.fn());
    pump.update({ ...input(1), sourceFrame: { ...input(1).sourceFrame, mediaTime: 0 } });
    await vi.advanceTimersByTimeAsync(2000);
    pump.heartbeat({ ...input(2).sourceFrame, mediaTime: 0 }, input(2).streamId); await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(2); expect(post.mock.calls[1][0].sourceFrame.mediaTime).toBe(0);
    pump.heartbeat({ ...input(2).sourceFrame, mediaTime: 0 }, input(2).streamId); await vi.advanceTimersByTimeAsync(1000); expect(post).toHaveBeenCalledTimes(2); pump.stop();
  });
  it('spaces server arrivals despite 150ms then 20ms network latency', async () => {
    vi.useFakeTimers(); const arrivals: number[] = []; const failed = vi.fn();
    const post = vi.fn((body: LivePreviewInput) => new Promise<Patch>((resolve, reject) => setTimeout(() => {
      const now = performance.now(); const previous = arrivals.at(-1); arrivals.push(now);
      if (previous !== undefined && now - previous < 500) reject(Object.assign(new Error('rate'), { status: 409, code: 'preview_rate_limit', retryAfterMs: 500 - now + previous }));
      else resolve(patch(body.sourceFrame.presentedFrames));
    }, post.mock.calls.length === 1 ? 150 : 20)));
    const pump = new LivePreviewPump(post, vi.fn(), failed);
    pump.update(input(1)); await vi.advanceTimersByTimeAsync(50); pump.update(input(2));
    await vi.advanceTimersByTimeAsync(620);
    expect(arrivals).toHaveLength(2); expect(arrivals[1] - arrivals[0]).toBeGreaterThanOrEqual(500); expect(failed).not.toHaveBeenCalled(); pump.stop();
  });
  it('honors retryAfterMs with the latest actual frame without replaying rejected frames', async () => {
    vi.useFakeTimers(); const failed = vi.fn();
    const post = vi.fn(async (body: LivePreviewInput) => {
      if (post.mock.calls.length === 1) throw Object.assign(new Error('rate'), { status: 409, code: 'preview_rate_limit', retryAfterMs: 800 });
      return patch(body.sourceFrame.presentedFrames);
    });
    const pump = new LivePreviewPump(post, vi.fn(), failed);
    pump.update(input(0)); await vi.advanceTimersByTimeAsync(0);
    pump.update(input(1)); pump.update(input(2)); await vi.advanceTimersByTimeAsync(799);
    expect(post).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(post).toHaveBeenCalledTimes(2); expect(post.mock.calls[1][0]).toEqual(input(2));
    pump.stop();
    const idlePost = vi.fn(async (_body: LivePreviewInput): Promise<Patch> => { throw Object.assign(new Error('rate'), { status: 409, code: 'preview_rate_limit', retryAfterMs: 600 }); });
    const idle = new LivePreviewPump(idlePost, vi.fn(), failed); idle.update(input(0)); await vi.advanceTimersByTimeAsync(2000);
    expect(idlePost).toHaveBeenCalledOnce(); idle.stop(); idle.update(input(1)); await vi.advanceTimersByTimeAsync(1000); expect(idlePost).toHaveBeenCalledOnce();
  });
  it('drops the rate-limit cooldown and pending latest frame when explicitly stopped', async () => {
    vi.useFakeTimers(); const failed = vi.fn();
    const post = vi.fn(async (_body: LivePreviewInput): Promise<Patch> => { throw Object.assign(new Error('rate'), { status: 409, code: 'preview_rate_limit', retryAfterMs: 900 }); });
    const pump = new LivePreviewPump(post, vi.fn(), failed); pump.update(input(1)); await vi.advanceTimersByTimeAsync(0); pump.update(input(2));
    await vi.advanceTimersByTimeAsync(400); pump.stop(); await vi.advanceTimersByTimeAsync(1000);
    expect(post).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
  });
  it('does not treat other 409 errors or malformed retry metadata as a safe rate delay', async () => {
    vi.useFakeTimers();
    for (const detail of [{ status: 409, code: 'preview_stream_dimensions_changed', retryAfterMs: 600 }, { status: 409, code: 'preview_rate_limit', retryAfterMs: NaN }, { status: 403, code: 'preview_rate_limit', retryAfterMs: 600 }]) {
      const failure = Object.assign(new Error('true error'), detail), failed = vi.fn(), post = vi.fn(async (_body: LivePreviewInput): Promise<Patch> => { throw failure; });
      const pump = new LivePreviewPump(post, vi.fn(), failed); pump.update(input(1)); await vi.advanceTimersByTimeAsync(0); pump.update(input(2)); await vi.advanceTimersByTimeAsync(1000);
      expect(post).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledWith(failure);
    }
  });
  it('drops aged queued detections and stops on an error without automatic retries', async () => {
    vi.useFakeTimers(); let release!: (p: Patch) => void;
    const post = vi.fn((_body: LivePreviewInput) => new Promise<Patch>(resolve => { release = resolve; }));
    const pump = new LivePreviewPump(post, vi.fn(), vi.fn());
    pump.update(input(1)); pump.update(input(2)); await vi.advanceTimersByTimeAsync(2600); release(patch(1)); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0); expect(post).toHaveBeenCalledOnce();
    pump.stop();
    const failed = vi.fn(), reject = vi.fn(async (_body: LivePreviewInput): Promise<Patch> => { throw new Error('offline'); });
    const failing = new LivePreviewPump(reject, vi.fn(), failed);
    failing.update(input(1)); await vi.advanceTimersByTimeAsync(0); failing.update(input(2)); await vi.advanceTimersByTimeAsync(1000);
    expect(reject).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
  });
  it('limits requests to 2Hz, deduplicates video identity and replaces slow backlog with only the latest', async () => {
    vi.useFakeTimers(); let release!: (p: Patch) => void;
    const post = vi.fn((_body: LivePreviewInput) => new Promise<Patch>(resolve => { release = resolve; })), rendered = vi.fn();
    const pump = new LivePreviewPump(post, rendered, vi.fn());
    pump.update(input(1)); pump.update(input(2)); pump.update(input(3));
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(700); release(patch(1)); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(499); expect(post).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1);
    expect(post).toHaveBeenCalledTimes(2); expect(post.mock.calls[1][0].sourceFrame.presentedFrames).toBe(3);
    pump.update(input(3)); pump.update(input(4)); release(patch(3)); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(499); expect(post).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(post).toHaveBeenCalledTimes(3);
    pump.stop(); release(patch(4)); await Promise.resolve(); expect(rendered).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); expect(post).toHaveBeenCalledTimes(3); vi.useRealTimers();
  });
});
describe('explicit continuous camera appearance preview', () => {
  it('logs actual native B frame rejected marker reasons and never pins stale output',async()=>{
    const trace=new TraceLog(),state={state:'fabric',profileVersion:0,paused:false,diagnosticsEnabled:false,capabilities:{display:{}}};
    render(<Workbench credentials={{sessionId:'s',token:'t',role:'camera'}} snapshot={state} mode="cameraMatch" api={{get:async()=>state,post:vi.fn()} as unknown as Api} send={vi.fn(()=>true)} getPatch={()=>({...patch(7),rendered:true})} pause={vi.fn()} refresh={vi.fn()} registerAbort={vi.fn()} trace={trace}/>);
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'بازکردن دوربین و دیدن کادر'}));});
    const value={phase:'cards',status:'needsFraming',nextAction:'',regions:[],marker:null,evidence:{candidateCount:3,cardCount:0,fabricCount:2,neutralCount:3,markerCandidates:0,motionSamples:30},frame:{presentedFrames:12,mediaTime:4,reportedMediaTime:0,timeSource:'callbackClock',width:2160,height:2160},processingMs:20,geometryStable:false,moving:true,fresh:false,debug:{analysisWidth:640,analysisHeight:640,markerSentinels:4,markerRejections:{ambiguousCells:3}},previewFeedbackRejectionReasons:['markerMissing'],previewBands:[{id:'secret-band',previewRgb:[0,0,0],top:0,bottom:1}]} as unknown as LiveTracking;
    act(()=>tracker.update?.(value));
    const row=trace.entries().find(row=>row.event==='evidence');expect(row?.details.evidenceSnapshot).toMatchObject({role:'camera',stage:'rejected',presentedFrames:12,rawMediaTime:0,nativeWidth:2160,analysisWidth:640,rejectionReasons:expect.arrayContaining(['markerMissing']),bands:[{targetRgb:[0,0,0]}]});
    expect((row?.details.evidenceSnapshot as {bands:object[]}).bands[0]).not.toHaveProperty('driveRgb');expect(trace.toJSON()).not.toContain('secret-band');
  });
  it('configures rendered band geometry and sends simultaneous measured appearance with same-frame targets', async () => {
    vi.useFakeTimers();
    const state = { state: 'fabric', profileVersion: 0, paused: false, capabilities: { display: {} } };
    let current: Patch | null = null;
    const post = vi.fn(async (_route: string, _body: unknown) => ({ ...patch(1), compensation: { status: 'measuredFeedbackExperimental' as const, feedbackApplied: true, perBand: [{ id: 'a', status: 'measuredFeedbackExperimental', residualBefore: 0.0321, saturated: false, warnings: [] }] } }));
    const props = { credentials: { sessionId: 's', token: 't', role: 'camera' as const }, snapshot: state, mode: 'cameraMatch' as const, api: { get: async () => state, post } as unknown as Api, send: vi.fn(() => true), getPatch: () => current, pause: vi.fn(), refresh: vi.fn(), registerAbort: vi.fn() };
    const view = render(<Workbench {...props} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'نمایش زندهٔ کالیته' })); });
    current = { ...patch(7), rendered: true, bands: [{ id: 'a', drive: [0.3, 0.4, 0.5], top: 0, bottom: 0.4 }, { id: 'b', drive: [0.6, 0.5, 0.4], top: 0.5, bottom: 1 }] };
    view.rerender(<Workbench {...props} />);
    expect(tracker.configure).toHaveBeenCalledWith(expect.objectContaining({ displayBands: { commandSequence: 7, bands: current.bands } }));
    const feedback = { markerSequence: 7, markerPixels: markerCells(7).map(bit => [bit, bit, bit]), screenRoi: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.8], [0.1, 0.8]], screenAppearanceBands: [{ id: 'a', rgb: [0.2, 0.3, 0.4], validPixels: 100, validBlocks: 9, blockSpread: 0.01, clippedRate: 0 }, { id: 'b', rgb: [0.5, 0.4, 0.3], validPixels: 100, validBlocks: 9, blockSpread: 0.01, clippedRate: 0 }] };
    const value = { phase: 'scene', status: 'ready', nextAction: '', regions: [], marker: { x: 64, y: 390, width: 280, height: 10 }, evidence: { candidateCount: 0, cardCount: 0, fabricCount: 2, neutralCount: 0, markerCandidates: 1, motionSamples: 3, markerSequence: 7 }, frame: input(10).sourceFrame, processingMs: 10, geometryStable: true, moving: false, fresh: true, previewBands: current.bands!.map(band => ({ ...band, previewRgb: [0.7, 0.2, 0.1] })), previewMapping: 'screenAligned', previewFeedback: feedback } as unknown as LiveTracking;
    act(() => tracker.update?.(value));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(post.mock.calls[1][1]).toMatchObject({ sourceFrame: input(10).sourceFrame, bands: [{ id: 'a', drive: [0.7, 0.2, 0.1] }, { id: 'b', drive: [0.7, 0.2, 0.1] }], feedback: { markerPixels: feedback.markerPixels, screenRoi: feedback.screenRoi, screenAppearanceBands: feedback.screenAppearanceBands, commandSequence: 7, patchId: 'p7', stable: true } });
    expect((post.mock.calls[1][1] as { feedback: object }).feedback).not.toHaveProperty('markerSequence');
    expect(screen.getByRole('status', { name: 'نوع جبران کالیته' })).toHaveTextContent('بازخورد اندازه‌گیری‌شدهٔ صفحه');
    expect(screen.getByLabelText('خطای پیش از اصلاح نوار a')).toHaveTextContent('RGB دوربین 0.0321');
    for (const unsafe of [{ moving: true }, { pixelMoving: true }, { surfaceChanged: true }, { geometryStable: false }, { status: 'ambiguous' }, { fresh: false }, { previewFeedback: { ...feedback, markerSequence: 6 } }, { previewFeedback: { ...feedback, markerPixels: markerCells(6).map(bit => [bit, bit, bit]) } }, { previewBands: [{ id: 'different', previewRgb: [0.7, 0.2, 0.1], top: 0, bottom: 1 }] }]) {
      const frame = input(11 + post.mock.calls.length).sourceFrame;
      act(() => tracker.update?.({ ...value, previewBands: value.previewBands!.map(band => ({ ...band, previewRgb: [0.7 + frame.presentedFrames / 1000, 0.2, 0.1] })), ...unsafe, frame } as LiveTracking));
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(post.mock.calls.at(-1)![1]).not.toHaveProperty('feedback');
    }
    const beforeEmpty = post.mock.calls.length;
    act(() => tracker.update?.({ ...value, previewBands: [], frame: input(29).sourceFrame }));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(post).toHaveBeenCalledTimes(beforeEmpty);
    act(() => tracker.update?.({ ...value, frame: input(30).sourceFrame }));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(post.mock.calls.at(-1)![1]).toHaveProperty('feedback');
    act(() => tracker.update?.({ ...value, frame: input(31).sourceFrame }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    act(() => tracker.update?.({ ...value, frame: input(32).sourceFrame }));
    const beforeStale = post.mock.calls.length;
    current = { ...current, commandSequence: 8, patchId: 'p8' };
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(post).toHaveBeenCalledTimes(beforeStale);
    act(() => tracker.update?.({ ...value, frame: input(33).sourceFrame, previewBands: value.previewBands!.map(band => ({ ...band, previewRgb: [0.8, 0.2, 0.1] })) }));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(post.mock.calls.at(-1)![1]).not.toHaveProperty('feedback');
  });
  it('attaches relative experimental feedback with a zero reported clock without inventing media time', async () => {
    vi.useFakeTimers();
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { configurable: true, value: vi.fn((callback: VideoFrameRequestCallback) => { queueMicrotask(() => callback(performance.now(), { presentedFrames: 1, mediaTime: 0 } as VideoFrameCallbackMetadata)); return 1; }) });
    const state = { state: 'fabric', profileVersion: 0, paused: false, capabilities: { display: {} } }, current = { ...patch(7), rendered: true }, post = vi.fn(async (_route: string, _body: unknown) => current);
    render(<Workbench credentials={{ sessionId: 's', token: 't', role: 'camera' }} snapshot={state} mode="cameraMatch" api={{ get: async () => state, post } as unknown as Api} send={vi.fn(() => true)} getPatch={() => current} pause={vi.fn()} refresh={vi.fn()} registerAbort={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'نمایش زندهٔ کالیته' })); });
    act(() => tracker.update?.({ phase: 'scene', status: 'ready', regions: [], marker: null, nextAction: '', evidence: { candidateCount: 0, cardCount: 0, fabricCount: 1, neutralCount: 0, markerCandidates: 1, motionSamples: 3, markerSequence: 7 }, frame: { ...input(10).sourceFrame, mediaTime: 2, reportedMediaTime: 0, timeSource: 'callbackClock' }, processingMs: 10, geometryStable: false, relativeGeometryStable: true, fresh: false, moving: false, previewBands: [{ ...current.bands![0], previewRgb: [0.3, 0.4, 0.5] }], previewFeedback: { markerSequence: 7, markerPixels: markerCells(7).map(bit => [bit, bit, bit]), screenRoi: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.8], [0.1, 0.8]], screenAppearanceBands: [{ id: 'b7', rgb: [0.2, 0.3, 0.4], validPixels: 100, validBlocks: 9, blockSpread: 0.01, clippedRate: 0 }] } }));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(post.mock.calls.at(-1)).toEqual(['live-preview', expect.objectContaining({ sourceFrame: { ...input(10).sourceFrame, mediaTime: 0 }, feedback: expect.objectContaining({ commandSequence: 7 }) })]);
    expect(screen.getByRole('status', { name: 'پایداری ردیابی' })).not.toHaveTextContent('سه تشخیص پایدار دریافت شد');
  });
  it('changes full mode only on explicit parent callback and never starts preview in that session', async () => {
    const onChoosePreview = vi.fn(), post = vi.fn(), send = vi.fn(() => true);
    render(<Workbench credentials={{ sessionId: 's', token: 't', role: 'camera' }} snapshot={{ state: 'reference', profileVersion: 0, paused: true }} mode="threeStage" api={{ post } as unknown as Api} send={send} getPatch={() => null} pause={vi.fn()} refresh={vi.fn()} registerAbort={vi.fn()} onChoosePreview={onChoosePreview} />);
    expect(screen.getByLabelText('مرجع لازم برای حالت کامل')).toHaveTextContent('سه کارت خنثی برای کنترل محدود');
    expect(onChoosePreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'نمایش زندهٔ کالیته آزمایشی' }));
    expect(onChoosePreview).toHaveBeenCalledOnce(); expect(post).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('keeps the locator alive with honest reported time through slow worker callbacks and stops on hidden', async () => {
    vi.useFakeTimers(); const state = { state: 'fabric', profileVersion: 0, paused: false, capabilities: { display: {} } };
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { configurable: true, value: vi.fn((callback: VideoFrameRequestCallback) => { queueMicrotask(() => callback(performance.now(), { presentedFrames: 1, mediaTime: 0 } as VideoFrameCallbackMetadata)); return 1; }) });
    const post = vi.fn(async (_route: string, _body: unknown) => patch(1));
    render(<Workbench credentials={{ sessionId: 's', token: 't', role: 'camera' }} snapshot={state} mode="cameraMatch" api={{ get: async () => state, post } as unknown as Api} send={vi.fn(() => true)} getPatch={() => null} pause={vi.fn()} refresh={vi.fn()} registerAbort={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'نمایش زندهٔ کالیته' })); });
    expect(post).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(post.mock.calls[0][1]).toMatchObject({fingerprint:'settings',canvasColorSpace:'srgb',cameraAppearanceColorSpace:'srgb'});
    act(() => tracker.options?.onFrame?.({ ...input(10).sourceFrame, mediaTime: 2, reportedMediaTime: 0, timeSource: 'callbackClock' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(post.mock.calls[1][1]).toMatchObject({ sourceFrame: { presentedFrames: 10, mediaTime: 0 } });
    expect((post.mock.calls[1][1] as LivePreviewInput).sourceFrame).not.toHaveProperty('timeSource');
    expect(post.mock.calls[1][1]).toMatchObject({fingerprint:'settings',canvasColorSpace:'srgb',cameraAppearanceColorSpace:'srgb'});
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    act(() => tracker.options?.onFrame?.({ ...input(11).sourceFrame, mediaTime: 3, reportedMediaTime: 0, timeSource: 'callbackClock' }));
    await act(() => vi.advanceTimersByTimeAsync(0)); expect(post).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });
  it('keeps last observed candidates as unknown while waiting and updates receipt age without further results', async () => {
    vi.useFakeTimers();
    const state = { state: 'reference', paused: true, profileVersion: 0 };
    render(<Workbench credentials={{ sessionId: 's', token: 't', role: 'camera' }} snapshot={state} mode="threeStage" api={{} as Api} send={vi.fn(() => true)} getPatch={() => null} pause={vi.fn()} refresh={vi.fn()} registerAbort={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' })); });
    expect(screen.getByText('دوربین باز است؛ هنوز اندازه‌گیری شروع نشده')).toBeInTheDocument();
    const value = { phase: 'cards', status: 'needsFraming', nextAction: 'سه کارت لازم است', regions: [], marker: null, evidence: { candidateCount: 1, cardCount: 0, fabricCount: 0, neutralCount: 0, markerCandidates: 0, motionSamples: 0 }, frame: { presentedFrames: 10, mediaTime: 1, width: 640, height: 480 }, processingMs: 1400, geometryStable: false, moving: false, fresh: true } as LiveTracking;
    act(() => tracker.update?.(value));
    act(() => tracker.update?.({ ...value, status: 'waiting', fresh: false, evidence: { ...value.evidence, candidateCount: 0 }, processingMs: 0 }));
    expect(screen.getByLabelText('شواهد ردیابی')).toHaveTextContent('آخرین نامزدهای مشاهده‌شده: 1');
    expect(screen.getByLabelText('شواهد ردیابی')).toHaveTextContent('UNKNOWN');
    await act(() => vi.advanceTimersByTimeAsync(3500));
    expect(screen.getByLabelText('ضربان پردازش')).toHaveTextContent('3.5 ثانیه');
    expect(screen.getByRole('status', { name: 'پایداری ردیابی' })).not.toHaveTextContent('سه تشخیص پایدار دریافت شد');
    expect(screen.getByLabelText('ضربان پردازش')).toHaveTextContent('دوربین پخش می‌شود، پردازش منتظر');
  });
  it('waits for server pause acknowledgement before resuming precise matching after stopping preview', async () => {
    let state = { state: 'fabric', profileVersion: 0, paused: false, capabilities: { camera: {}, display: {} } }; let stopping = false; let pauseReads = 0;
    const get = vi.fn(async () => { if (stopping && ++pauseReads >= 2) state = { ...state, paused: true }; return state; });
    const send = vi.fn((event: string) => { if (event === 'session.resume') { expect(state.paused).toBe(true); stopping = false; state = { ...state, paused: false }; } return true; });
    const pause = vi.fn((reason: string) => { if (reason === 'operator_pause') stopping = true; });
    const post = vi.fn(async () => patch(1));
    const scanScene = vi.fn(() => new Promise<never>(() => {}));
    const props = { credentials: { sessionId: 's', token: 't', role: 'camera' as const }, snapshot: state, mode: 'cameraMatch' as const, api: { get, post } as unknown as Api, send, getPatch: () => null, pause, refresh: vi.fn(), registerAbort: vi.fn(), scanScene };
    const view = render(<Workbench {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' })); await screen.findByText('دوربین باز است؛ هنوز اندازه‌گیری شروع نشده');
    fireEvent.click(screen.getByRole('button', { name: 'ادامه بدون کارت، آزمایشی' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' }));
    fireEvent.click(screen.getByRole('button', { name: 'نمایش زندهٔ کالیته' })); await waitFor(() => expect(post).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'توقف نمایش زنده' }));
    expect(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم' }));
    fireEvent.click(screen.getByRole('button', { name: 'تطبیق دقیق آزمایشی' }));
    view.rerender(<Workbench {...props} snapshot={{ ...state, paused: true, pauseReason: 'operator_pause' }} />);
    await waitFor(() => expect(send).toHaveBeenCalledWith('session.resume', { witnessChecked: true })); expect(pauseReads).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: 'توقف اجرای خودکار' }));
  });
  it('bootstraps a neutral locator before marker, stable geometry or optional cards exist', async () => {
    let state = { state: 'fabric', profileVersion: 0, paused: true, capabilities: { camera: {}, display: {} } };
    const post = vi.fn(async (_route: string, _body: unknown) => patch(1)), send = vi.fn((event: string) => { if (event === 'session.resume') state = { ...state, paused: false }; return true; });
    render(<Workbench credentials={{ sessionId: 's', token: 't', role: 'camera' }} snapshot={state} mode="cameraMatch" api={{ get: async () => state, post } as unknown as Api} send={send} getPatch={() => null} pause={vi.fn()} refresh={vi.fn()} registerAbort={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' })); await screen.findByText('دوربین باز است؛ هنوز اندازه‌گیری شروع نشده');
    fireEvent.click(screen.getByRole('button', { name: 'نمایش زندهٔ کالیته' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('live-preview', expect.objectContaining({ bands: [{ id: 'locator', drive: [0.5, 0.5, 0.5], top: 0, bottom: 1 }], mapping: 'orderedPreview' })));
    expect(send).toHaveBeenCalledWith('session.resume', { witnessChecked: true });
    expect(screen.getByRole('status', { name: 'وضعیت کالیتهٔ زنده' })).toHaveTextContent('در حال پیدا کردن نوارها');
    expect(post.mock.calls.every(([route]) => route === 'live-preview')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'توقف نمایش زنده' }));
  });
  it('updates moving partial geometry without approving measurements and stops on pause', async () => {
    const state = { state: 'fabric', profileVersion: 0, paused: false, capabilities: { camera: {}, display: {} } }, post = vi.fn(async (_route: string, _body: unknown) => patch(1)), pause = vi.fn();
    const props = { credentials: { sessionId: 's', token: 't', role: 'camera' as const }, snapshot: state, mode: 'cameraMatch' as const, api: { get: async () => state, post } as unknown as Api, send: vi.fn(() => true), getPatch: () => null, pause, refresh: vi.fn(), registerAbort: vi.fn() };
    const view = render(<Workbench {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر' })); await screen.findByText('دوربین باز است؛ هنوز اندازه‌گیری شروع نشده');
    fireEvent.click(screen.getByRole('button', { name: 'نمایش زندهٔ کالیته' })); await waitFor(() => expect(post).toHaveBeenCalledOnce());
    const value = { phase: 'scene', status: 'needsFraming', nextAction: 'marker missing', regions: [], marker: null, evidence: { candidateCount: 0, cardCount: 0, fabricCount: 2, neutralCount: 0, markerCandidates: 0, motionSamples: 1 }, frame: { presentedFrames: 10, mediaTime: 1, width: 640, height: 480 }, processingMs: 10, geometryStable: false, moving: true, fresh: true, previewBands: [{ id: 'fabric1', previewRgb: [0.8, 0.2, 0.1], top: 0.1, bottom: 0.4 }, { id: 'fabric2', previewRgb: [0.2, 0.4, 0.7], top: 0.5, bottom: 0.8 }], previewMapping: 'screenAligned', previewWarnings: [] } as LiveTracking;
    act(() => tracker.update?.(value));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).toMatchObject({ bands: [{ id: 'fabric1', drive: [0.8, 0.2, 0.1], top: 0.1, bottom: 0.4 }, { id: 'fabric2', drive: [0.2, 0.4, 0.7], top: 0.5, bottom: 0.8 }], mapping: 'screenAligned' });
    expect(pause).not.toHaveBeenCalledWith('camera_moved'); expect(screen.getByRole('status', { name: 'وضعیت کالیتهٔ زنده' })).toHaveTextContent('حرکت');
    view.rerender(<Workbench {...props} snapshot={{ ...state, paused: true, pauseReason: 'device_disconnected' }} />);
    act(() => tracker.update?.({ ...value, frame: { ...value.frame, presentedFrames: 11, mediaTime: 1.1 } }));
    await new Promise(resolve => setTimeout(resolve, 550)); expect(post).toHaveBeenCalledTimes(2);
  });
});
