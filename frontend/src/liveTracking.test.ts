import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeTracking, LiveTracker, type LiveTracking, type TrackingDetection, type TrackingState, type TrackingWorker } from './liveTracking';
import type { Region } from './sampling';
import { processTrackingFrame, type TrackingRequest, type WorkerTrackingState } from './tracking.worker';
import { markerCells, type PixelImage } from './marker';

function region(id: string, x = 50): Region {
  return { id, label: id, order: 0, mode: 'solid', polygon: [[x, 40], [x + 100, 40], [x + 100, 100], [x, 100]], exclusions: [], background: null, layers: null, direction: null, operatorConfirmed: false, selectionMethod: 'autoDetected' };
}
function detection(index: number, changes: Partial<TrackingDetection> = {}): TrackingDetection {
  return { phase: 'cards', status: 'ready', nextAction: 'Hold still', regions: [region('dark'), region('middle', 200), region('light', 350)], marker: null, evidence: { candidateCount: 3, cardCount: 3, fabricCount: 0, neutralCount: 0, markerCandidates: 0, motionSamples: 100 }, frame: { presentedFrames: index, mediaTime: index / 2, width: 1280, height: 720 }, processingMs: 500, pixelMoving: false, ...changes };
}

describe('native geometry tracking', () => {
  it('requires three fresh detections and immediately invalidates on shift or loss', () => {
    let state: TrackingState | null = null;
    state = computeTracking(state, detection(1));
    expect(state.tracking.geometryStable).toBe(false);
    state = computeTracking(state, detection(2));
    expect(state.tracking.geometryStable).toBe(false);
    state = computeTracking(state, detection(3));
    expect(state.tracking.geometryStable).toBe(true);
    expect(state.tracking.moving).toBe(false);
    const shifted = computeTracking(state, detection(4, { regions: [region('dark', 90), region('middle', 240), region('light', 390)] }));
    expect(shifted.tracking).toMatchObject({ moving: true, geometryStable: false });
    const lost = computeTracking(state, detection(4, { status: 'needsFraming', regions: [] }));
    expect(lost.tracking).toMatchObject({ moving: true, geometryStable: false, regions: [] });
    expect(computeTracking(null, detection(1, { status: 'needsFraming', regions: [] })).tracking.geometryStable).toBe(false);
    expect(computeTracking(state, detection(3))).toBe(state);
  });
});

function raster(width = 640, height = 480): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([83, 72, 61, 255], i);
  return { width, height, data };
}
function paint(image: PixelImage, x: number, y: number, width: number, height: number, rgb: number[]) {
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) image.data.set([...rgb, 255], (yy * image.width + xx) * 4);
}
function scene(sequence = 1, rgb = [93, 137, 167]) {
  const image = raster();
  paint(image, 315, 105, 270, 180, [119, 119, 119]);
  paint(image, 320, 110, 260, 170, rgb);
  markerCells(sequence).forEach((bit, i) => paint(image, 310 + i * 10, 300, 10, 20, bit ? [250, 250, 250] : [5, 5, 5]));
  [[170, 94, 81], [177, 99, 86], [103, 141, 157]].forEach((color, i) => paint(image, 45, 80 + i * 70, 170, 70, color));
  return image;
}
function request(image: PixelImage, index: number, phase: 'cards' | 'scene' = 'scene', expectedSequence = 1): TrackingRequest {
  return { id: index, generation: 1, phase, expectedSequence, mode: 'cameraMatch', image: { ...image, data: image.data as Uint8ClampedArray }, frame: { presentedFrames: index, mediaTime: index / 2, width: image.width * 2, height: image.height * 2 } };
}

describe('worker geometry and camera motion', () => {
  it('retains explicit marker rejection evidence when no preview samples can be authorized',()=>{
    const source=scene(7);paint(source,320,300,260,20,[128,128,128]);
    const result=processTrackingFrame({...request(source,1),expectedSequence:undefined,displayBands:{commandSequence:7,bands:[{id:'dark',top:0,bottom:1,drive:[0,0,0]}]}},null).tracking.tracking;
    expect(result.previewFeedbackRejectionReasons).toContain('markerMissing');
    expect(result.debug?.markerRejections).toBeDefined();expect(result.previewFeedback).toBeUndefined();
  });
  it('ignores only the observed phone footer corridor while retaining outside motion checks',()=>{
    let state:WorkerTrackingState|null=null;
    for(let sequence=1;sequence<=5;sequence++){
      const image=raster();paint(image,315,75,270,195,[119,119,119]);paint(image,320,80,260,170,[93,137,167]);
      paint(image,320,270,260,55,sequence%2?[30,30,30]:[235,235,235]);
      markerCells(sequence).forEach((bit,i)=>paint(image,310+i*10,330,10,20,bit?[250,250,250]:[5,5,5]));
      [[170,94,81],[177,99,86],[103,141,157]].forEach((rgb,i)=>paint(image,45,80+i*70,170,70,rgb));
      state=processTrackingFrame({...request(image,sequence),expectedSequence:undefined},state);
      expect(state.tracking.tracking.pixelMoving).toBe(false);
    }
    expect(state!.tracking.tracking.geometryStable).toBe(true);
    const changed=raster();paint(changed,0,0,640,60,[230,230,230]);
    expect(processTrackingFrame({...request(changed,6),expectedSequence:undefined},state).tracking.tracking.pixelMoving).toBe(true);
  },20000);
  it('keeps static fabric feedback stable while the phone on the left changes its displayed stripes',()=>{
    let state:WorkerTrackingState|null=null;
    for(let sequence=1;sequence<=6;sequence++){
      const image=raster();
      for(let y=0;y<480;y++){const band=Math.floor(y/60),shade=Math.round(8*Math.sin(y/16));paint(image,0,y,640,1,[95+band*12+shade,65+band*10+shade,55+band*9+shade]);}
      paint(image,18,68,180,270,[85,85,85]);paint(image,23,73,170,224,[0,0,0]);
      if(sequence===1)paint(image,25,75,166,220,[128,128,128]);
      else{paint(image,25,75,166,37,[100,80,60]);paint(image,25,122,166,54,[120,90,75]);paint(image,25,186,166,105,[150,120,100]);}
      markerCells(sequence).forEach((bit,i)=>paint(image,24+i*6,306,6,12,bit?[255,255,255]:[0,0,0]));
      paint(image,255,95,85,120,[41,45,52]);paint(image,455,86,90,118,[128,137,150]);paint(image,340,335,105,70,[209,216,225]);
      state=processTrackingFrame({...request(image,sequence),expectedSequence:undefined,displayBands:{commandSequence:sequence,bands:[{id:'first',top:0,bottom:.5,drive:[.4,.5,.6]},{id:'second',top:.5,bottom:1,drive:[.4,.5,.6]}]}},state);
      if(sequence>=4){expect(state.tracking.tracking.pixelMoving).toBe(false);expect(state.tracking.tracking.surfaceChanged).toBe(false);}
      expect(state.tracking.tracking.previewFeedback).toBeDefined();
      expect(state.tracking.tracking.previewFeedback?.screenRoi).toEqual([[25/640,75/480],[191/640,75/480],[191/640,295/480],[25/640,295/480]]);
    }
    expect(state!.tracking.tracking.geometryStable).toBe(true);
  },20000);
  it('co-samples commanded screen bands and fabric only when the actual marker agrees',()=>{
    const source={...request(scene(7),1),expectedSequence:undefined,displayBands:{commandSequence:7,bands:[{id:'first',top:0,bottom:.5,drive:[.4,.5,.6] as [number,number,number]},{id:'second',top:.5,bottom:1,drive:[.4,.5,.6] as [number,number,number]}]}};
    const result=processTrackingFrame(source,null).tracking.tracking;
    expect(result.previewFeedback?.markerSequence).toBe(7);
    expect(result.previewFeedback?.markerPixels).toHaveLength(28);
    expect(result.previewFeedback?.screenAppearanceBands.map(b=>b.id)).toEqual(['first','second']);
    expect(result.previewFeedback?.screenRoi.every(p=>p.every(v=>v>=0&&v<=1))).toBe(true);
    expect(processTrackingFrame({...source,displayBands:{...source.displayBands,commandSequence:8}},null).tracking.tracking.previewFeedback).toBeUndefined();
    expect(processTrackingFrame({...source,image:{...source.image,data:new Uint8ClampedArray(source.image.data.length).fill(255)}},null).tracking.tracking.previewFeedback).toBeUndefined();
  });
  it('forgets prior full aperture evidence when the marker disappears or the native frame changes',()=>{
    const source={...request(scene(7),1),expectedSequence:undefined,displayBands:{commandSequence:7,bands:[{id:'all',top:0,bottom:1,drive:[.4,.5,.6] as [number,number,number]}]}};
    const first=processTrackingFrame(source,null);expect(first.displayAnchor).toBeDefined();
    const lost=processTrackingFrame({...source,id:2,frame:{...source.frame,presentedFrames:2,mediaTime:1},image:{...source.image,data:new Uint8ClampedArray(source.image.data.length).fill(255)}},first);
    expect(lost.displayAnchor).toBeUndefined();expect(lost.tracking.tracking.previewFeedback).toBeUndefined();
    const changed=processTrackingFrame({...source,id:3,frame:{...source.frame,width:1920,height:1440,presentedFrames:3,mediaTime:1.5}},first);
    expect(changed.tracking.tracking.geometryStable).toBe(false);
  });
  it('invalidates historical aperture evidence on observed outside motion before later settling',()=>{
    let state=processTrackingFrame({...request(scene(7),1),expectedSequence:undefined},null);
    const moved=scene(7);paint(moved,0,350,300,120,[220,220,220]);
    state=processTrackingFrame({...request(moved,2),expectedSequence:undefined},state);
    expect(state.tracking.tracking.pixelMoving).toBe(true);expect(state.displayAnchor).toBeUndefined();
  });
  it('tracks only one proposed witness and screen across finite pure-color response commands without fabric readiness',()=>{
    let state:WorkerTrackingState|null=null;
    for(let i=1;i<=6;i++){
      const image=scene(i,i%3===1?[0,0,0]:i%3===2?[255,255,255]:[0,0,255]);
      paint(image,30,60,220,300,[210,195,170]);
      paint(image,70,95,100,160,[120,120,135]);
      state=processTrackingFrame({...request(image,i,'scene',i),purpose:'response'},state);
      expect(state.tracking.tracking.status).toBe('ready');
      expect(state.tracking.tracking.regions).toHaveLength(2);
      expect(state.tracking.tracking.evidence.fabricCount).toBe(0);
      expect(state.tracking.tracking.neutralCardRegions).toHaveLength(1);
      expect(state.tracking.tracking.pixelMoving).toBe(false);
      expect(state.tracking.tracking.surfaceChanged).toBe(false);
    }
    expect(state!.tracking.tracking.geometryStable).toBe(true);
    const changed=scene(7);paint(changed,30,60,220,300,[210,195,170]);paint(changed,70,95,100,160,[170,170,185]);
    const moved=processTrackingFrame({...request(changed,7,'scene',7),purpose:'response'},state);
    expect(moved.tracking.tracking.surfaceChanged).toBe(true);
    expect(moved.tracking.tracking.geometryStable).toBe(false);
  },10000);
  it('maps native polygons, strips detector extras and ignores command-color and marker changes', () => {
    let state: WorkerTrackingState | null = null;
    for (let i = 1; i <= 3; i++) state = processTrackingFrame(request(scene(i, i === 2 ? [0, 0, 0] : i === 3 ? [255, 255, 255] : [93, 137, 167]), i, 'scene', i), state);
    const result = state!.tracking.tracking;
    expect(result).toMatchObject({ geometryStable: true, moving: false, status: 'ready', frame: { width: 1280, height: 960, presentedFrames: 3 } });
    expect(result.marker).toMatchObject({ x: 620, width: 560 });
    expect(result.regions[0].polygon[0][0]).toBeGreaterThan(640);
    expect(result.regions).toHaveLength(4);
    result.regions.forEach(r => { expect(r.selectionMethod).toBe('autoDetected'); expect(r.operatorConfirmed).toBe(false); expect(r).not.toHaveProperty('source'); expect(r).not.toHaveProperty('confidence'); });
    expect(JSON.stringify(result)).not.toMatch(/pixels|observedRgb|fingerprint|data/);
    expect(result.evidence.markerSequence).toBe(3);
  });

  it('detects background motion even when objects cannot be detected and ignores unknown right-screen drive', () => {
    const initial = raster();
    const state = processTrackingFrame(request(initial, 1), null);
    const screenOnly = raster(); paint(screenOnly, 320, 0, 320, 480, [255, 255, 255]);
    const unchanged = processTrackingFrame(request(screenOnly, 2), state);
    expect(unchanged.tracking.tracking).toMatchObject({ moving: false, geometryStable: false });
    const changed = raster(); paint(changed, 0, 0, 260, 480, [170, 170, 170]);
    const moved = processTrackingFrame(request(changed, 3), unchanged);
    expect(moved.tracking.tracking).toMatchObject({ moving: true, geometryStable: false, regions: [] });
    expect(moved.tracking.tracking.evidence.motionSamples).toBeGreaterThan(20);
  });

  it('requires exactly three cards and does not export their RGB observations', () => {
    const image = raster(320, 240);
    [[20, 20, 20], [120, 120, 120], [230, 230, 230]].forEach((rgb, i) => paint(image, 15 + i * 100, 85, 80, 50, rgb));
    const result = processTrackingFrame(request(image, 1, 'cards'), null).tracking.tracking;
    expect(result.status).toBe('ready');
    expect(result.regions).toHaveLength(3);
    expect(result.evidence.cardCount).toBe(3);
    expect(JSON.stringify(result)).not.toContain('observedRgb');
  });
});

function harness() {
  const video = document.createElement('video');
  Object.defineProperties(video, { videoWidth: { value: 1920, configurable: true }, videoHeight: { value: 1080, configurable: true }, readyState: { value: 2, configurable: true } });
  let next = 0;
  const callbacks = new Map<number, VideoFrameRequestCallback>();
  video.requestVideoFrameCallback = vi.fn(callback => { callbacks.set(++next, callback); return next; });
  video.cancelVideoFrameCallback = vi.fn(id => { callbacks.delete(id); });
  const fire = (index: number, now: number, mediaTime = index / 30) => {
    const entry = callbacks.entries().next().value;
    if (!entry) throw new Error('No video callback');
    callbacks.delete(entry[0]);
    entry[1](now, { presentedFrames: index, mediaTime, width: 1920, height: 1080 } as VideoFrameCallbackMetadata);
  };
  const workers: (TrackingWorker & { jobs: TrackingRequest[]; finish: (job?: TrackingRequest, changes?: Partial<TrackingDetection>) => void })[] = [];
  const workerFactory = () => {
    const jobs: TrackingRequest[] = [];
    let state: TrackingState | null = null;
    const worker: TrackingWorker & { jobs: TrackingRequest[]; finish: (job?: TrackingRequest, changes?: Partial<TrackingDetection>) => void } = { jobs, onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(message => jobs.push(message)), terminate: vi.fn(), finish(job = jobs.at(-1)!, changes = {}) {
      state = computeTracking(state, detection(job.frame.presentedFrames, { phase: job.phase, frame: job.frame, ...(job.phase === 'scene' ? { marker: { x: 400, y: 300, width: 280, height: 20 } } : {}), ...changes }));
      const result = state.tracking;
      worker.onmessage?.({ data: { id: job.id, generation: job.generation, frame: job.frame, tracking: result } } as MessageEvent);
    } };
    workers.push(worker); return worker;
  };
  const readFrame = vi.fn((_video: HTMLVideoElement, width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
  const updates: LiveTracking[] = [], onError = vi.fn();
  const tracker = new LiveTracker(video, value => updates.push(value), { phase: 'cards', workerFactory, readFrame, onError });
  return { video, fire, workers, callbacks, tracker, readFrame, updates, onError, workerFactory };
}
afterEach(() => { vi.useRealTimers(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });

describe('continuous bounded video scheduling', () => {
  it('continues geometry-only preview on increasing real frames with a frozen media clock without fresh physical proof', () => {
    vi.useFakeTimers();
    const h = harness(); h.tracker.start();
    for (let index = 1; index <= 8; index++) {
      h.fire(index, performance.now(), 0); h.workers[0].finish(undefined, { processingMs: 100 });
      if (index > 1) expect(h.updates.at(-1)).toMatchObject({ fresh: false, geometryStable: false, frame: { presentedFrames: index, reportedMediaTime: 0, timeSource: 'callbackClock' }, debug: { reason: 'callbackClock' } });
      if(index>3)expect(h.updates.at(-1)?.relativeGeometryStable).toBe(true);
      vi.advanceTimersByTime(1000);
    }
    expect(h.workers[0].jobs).toHaveLength(8);
    expect(h.workers[0].terminate).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.updates.at(-1)?.regions).toHaveLength(3);
    h.tracker.stop();
  });

  it('requires a new three-detection history when a real media clock resumes after callback-clock preview', () => {
    const image = raster(320, 240);
    [[20, 20, 20], [120, 120, 120], [230, 230, 230]].forEach((rgb, i) => paint(image, 15 + i * 100, 85, 80, 50, rgb));
    let state: WorkerTrackingState | null = null;
    for (let i = 1; i <= 3; i++) {
      const job = request(image, i, 'cards');
      state = processTrackingFrame({ ...job, frame: { ...job.frame, mediaTime: i + 10, reportedMediaTime: 0, timeSource: 'callbackClock' } }, state);
    }
    const fresh = request(image, 4, 'cards');
    state = processTrackingFrame({ ...fresh, frame: { ...fresh.frame, mediaTime: 0.1, reportedMediaTime: 0.1, timeSource: 'videoMediaTime' } }, state);
    expect(state.tracking.tracking).toMatchObject({ geometryStable: false, pixelMoving: false, surfaceChanged: false, frame: { presentedFrames: 4, mediaTime: 0.1, timeSource: 'videoMediaTime' } });
    expect(state.tracking.tracking.evidence.motionSamples).toBe(0);
  });

  it('emits actual fresh frame heartbeats while the single detector job remains pending without extra reads', () => {
    vi.useFakeTimers();
    const h = harness(), onFrame = vi.fn();
    const tracker = new LiveTracker(h.video, value => h.updates.push(value), { phase: 'cards', workerFactory: h.workerFactory, readFrame: h.readFrame, onFrame });
    tracker.start(); h.fire(1, 0);
    vi.advanceTimersByTime(500); h.fire(2, performance.now());
    h.fire(2, performance.now());
    vi.advanceTimersByTime(500); h.fire(3, performance.now());
    expect(onFrame.mock.calls.map(([frame]) => frame.presentedFrames)).toEqual([1, 2, 3]);
    expect(onFrame.mock.calls[2][0]).toMatchObject({ width: 1920, height: 1080, mediaTime: 3 / 30 });
    expect(h.readFrame).toHaveBeenCalledTimes(1);
    expect(h.workers[0].jobs).toHaveLength(1);
    expect(h.updates.some(value => value.fresh)).toBe(false);
    tracker.stop(); expect(h.callbacks.size).toBe(0);
  });

  it('recovers three hard timeouts at smaller resolution and keeps fresh stable updates flowing for six seconds', () => {
    vi.useFakeTimers();
    const h = harness(); h.tracker.configure({ phase: 'scene' }); h.tracker.start();
    let index = 0;
    for (const edge of [640, 480, 320]) {
      h.fire(++index, performance.now());
      const worker = h.workers.at(-1)!;
      expect(Math.max(worker.jobs[0].image.width, worker.jobs[0].image.height)).toBe(edge);
      vi.advanceTimersByTime(2500);
      expect(h.updates.at(-1)).toMatchObject({ status: 'waiting', fresh: false, geometryStable: false, regions: [] });
      expect(h.updates.at(-1)?.nextAction).toContain('کند');
      expect(worker.terminate).not.toHaveBeenCalled();
      h.fire(++index, performance.now()); expect(worker.jobs).toHaveLength(1);
      vi.advanceTimersByTime(5500);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(h.onError).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
    }
    for (let second = 0; second <= 6; second++) {
      h.fire(++index, performance.now());
      const worker = h.workers.at(-1)!;
      vi.advanceTimersByTime(100); worker.finish(undefined, { processingMs: 100 });
      expect(h.updates.at(-1)).toMatchObject({ status: 'ready', fresh: true });
      if (second >= 2) expect(h.updates.at(-1)?.geometryStable).toBe(true);
      vi.advanceTimersByTime(900);
    }
    expect(h.workers).toHaveLength(4);
    expect(h.updates.at(-1)?.debug).toMatchObject({ analysisWidth: 256, analysisHeight: 144, timeouts: 3, jobsStarted: 10, jobsCompleted: 7, retries: 3 });
    expect(h.callbacks.size).toBe(1);
    h.tracker.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it('reads the actual callback once at <=640 and never queues detector work while in flight', () => {
    const h = harness(); h.tracker.start();
    h.fire(1, 0);
    expect(h.readFrame).toHaveBeenCalledExactlyOnceWith(h.video, 480, 270);
    expect(h.workers[0].jobs[0].frame).toEqual({ presentedFrames: 1, mediaTime: 1 / 30, width: 1920, height: 1080, timeSource: 'videoMediaTime', reportedMediaTime: 1 / 30 });
    h.fire(2, 500); h.fire(3, 1000);
    expect(h.readFrame).toHaveBeenCalledTimes(1);
    expect(h.workers[0].jobs).toHaveLength(1);
    h.workers[0].finish();
    h.fire(4, 1100);
    expect(h.workers[0].jobs).toHaveLength(2);
    expect(h.workers[0].jobs[1].frame.presentedFrames).toBe(4);
    h.workers[0].finish(); h.fire(5, 1200);
    expect(h.readFrame).toHaveBeenCalledTimes(2);
    h.tracker.stop();
  });

  it('drops old configuration responses and duplicate real frames without queued replacement work', () => {
    const h = harness(); h.tracker.start(); h.fire(1, 0);
    const old = h.workers[0].jobs[0];
    h.tracker.configure({ phase: 'scene', expectedSequence: 8, mode: 'cameraMatch' });
    expect(h.updates.at(-1)).toMatchObject({ phase: 'scene', status: 'waiting', regions: [], geometryStable: false, fresh: false, expectedSequence: 8 });
    expect(h.workers[0].terminate).toHaveBeenCalledOnce();
    h.workers[0].finish(old);
    expect(h.updates.filter(value => value.status === 'ready')).toHaveLength(0);
    h.fire(2, 600);
    expect(h.workers[1].jobs[0]).toMatchObject({ phase: 'scene', expectedSequence: 8, mode: 'cameraMatch' });
    h.workers[1].finish(); h.fire(2, 1500);
    expect(h.workers[1].jobs).toHaveLength(1);
    h.tracker.stop(); h.workers[0].finish();
    expect(h.callbacks.size).toBe(0);
    expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
  });
  it('updates displayed-band feedback context without resetting in-flight geometry or worker history',()=>{
    const h=harness();h.tracker.start();h.fire(1,0);
    const job=h.workers[0].jobs[0],bands={commandSequence:7,bands:[{id:'fabric',drive:[.2,.3,.4] as [number,number,number],top:0,bottom:1}]};
    h.tracker.configure({displayBands:bands});
    expect(h.workers[0].terminate).not.toHaveBeenCalled();
    h.workers[0].finish(job);h.fire(2,700);
    expect(h.workers[0].jobs[1].displayBands).toEqual(bands);
    expect(h.workers[0].jobs[1].generation).toBe(job.generation);
    h.tracker.configure({displayBands:undefined});h.workers[0].finish();h.fire(3,1400);
    expect(h.workers[0].jobs[2].displayBands).toBeUndefined();h.tracker.stop();
  });

  it('waits silently for permission/dimensions then stops on abort', () => {
    const h = harness();
    Object.defineProperty(h.video, 'videoWidth', { configurable: true, value: 0 });
    h.tracker.start(); h.fire(1, 0); h.fire(2, 600);
    expect(h.workers).toHaveLength(0);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(1);
    Object.defineProperty(h.video, 'videoWidth', { configurable: true, value: 1920 });
    h.fire(3, 1200);
    expect(h.workers[0].jobs).toHaveLength(1);
    h.tracker.stop();
    const abort = new AbortController();
    const tracker = new LiveTracker(h.video, () => {}, { phase: 'cards', signal: abort.signal, workerFactory: () => h.workers[0], readFrame: h.readFrame });
    tracker.start(); h.fire(4, 1600); abort.abort();
    expect(h.callbacks.size).toBe(0);
  });

  it('terminates hidden work, discards its late response and resumes only fresh visible frames', () => {
    const h = harness(); h.tracker.start(); h.fire(1, 0);
    const oldWorker = h.workers[0];
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.callbacks.size).toBe(0);
    expect(oldWorker.terminate).toHaveBeenCalledTimes(1);
    oldWorker.finish(); expect(h.updates.some(r => r.status === 'ready')).toBe(false);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    h.fire(2, 1000);
    oldWorker.onerror?.(new ErrorEvent('error'));
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.workers).toHaveLength(2);
    h.workers[1].finish(); expect(h.updates.at(-1)?.frame.presentedFrames).toBe(2);
    h.tracker.stop();
  });

  it('retries genuine worker errors twice then reports one fatal error after the third consecutive crash', () => {
    vi.useFakeTimers();
    const h = harness(); h.tracker.start(); h.fire(1, 0);
    for (let attempt = 0; attempt < 3; attempt++) {
      h.workers[attempt].onerror?.(new ErrorEvent('error'));
      h.workers[attempt].onerror?.(new ErrorEvent('error'));
      if (attempt < 2) {
        expect(h.onError).not.toHaveBeenCalled();
        expect(h.updates.at(-1)).toMatchObject({ status: 'waiting', fresh: false, regions: [] });
        vi.advanceTimersByTime(500); h.fire(attempt + 2, performance.now());
      }
    }
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.updates.at(-1)).toMatchObject({ status: 'error', regions: [], geometryStable: false });
    expect(h.callbacks.size).toBe(0);
  });

  it('invalidates accepted geometry on video starvation with one bounded waiting notification', () => {
    vi.useFakeTimers();
    const h = harness(); h.tracker.start(); h.fire(1, 0); h.workers[0].finish();
    vi.advanceTimersByTime(3000);
    expect(h.updates.at(-1)).toMatchObject({ status: 'waiting', moving: true, regions: [], geometryStable: false });
    vi.advanceTimersByTime(10000);
    expect(h.updates.filter(r => r.status === 'waiting')).toHaveLength(2);
    h.tracker.stop();
  });

  it('caps the adaptive interval at 1000ms and does not retain geometry beyond the freshness deadline', () => {
    vi.useFakeTimers();
    const h = harness(); h.tracker.start(); h.fire(1, 0);
    const worker = h.workers[0], job = worker.jobs[0];
    const tracking = computeTracking(null, detection(1, { frame: job.frame, processingMs: 1200 })).tracking;
    worker.onmessage?.({ data: { id: job.id, generation: job.generation, frame: job.frame, tracking } } as MessageEvent);
    h.fire(2, 900); expect(worker.jobs).toHaveLength(1);
    h.fire(3, 1000); expect(worker.jobs).toHaveLength(2);
    vi.advanceTimersByTime(2500);
    expect(h.updates.at(-1)).toMatchObject({ fresh: false, geometryStable: false, regions: [] });
    h.tracker.stop();
  });

  it('uses exactly one canvas draw/read inside rVFC without requiring a native full-frame canvas', () => {
    const h = harness();
    const drawImage = vi.fn(), getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(640 * 360 * 4) }));
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, getImageData } as unknown as CanvasRenderingContext2D);
    const tracker = new LiveTracker(h.video, () => {}, { phase: 'scene', workerFactory: () => h.workers[0] });
    h.tracker.start(); h.fire(1, 0); h.tracker.stop();
    tracker.start(); h.fire(2, 600);
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(h.video, 0, 0, 640, 360);
    expect(getImageData).toHaveBeenCalledExactlyOnceWith(0, 0, 640, 360);
    tracker.stop(); context.mockRestore();
  });

  it('leaves no watchdog when the owner stops synchronously from its update callback', () => {
    vi.useFakeTimers();
    const h = harness(); h.tracker.start(); h.fire(1, 0); h.tracker.stop();
    let tracker: LiveTracker;
    tracker = new LiveTracker(h.video, value => { if (value.status === 'ready') tracker.stop(); }, { phase: 'cards', workerFactory: () => h.workers[0], readFrame: h.readFrame });
    tracker.start(); h.fire(2, 600); h.workers[0].finish();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.callbacks.size).toBe(0);
  });

  it('rejects a worker result whose actual tracking identity differs from the submitted frame', () => {
    const h = harness(); h.tracker.start(); h.fire(1, 0);
    const worker = h.workers[0], job = worker.jobs[0];
    worker.onmessage?.({ data: { id: job.id, generation: job.generation, frame: job.frame, tracking: computeTracking(null, detection(99)).tracking } } as MessageEvent);
    expect(h.updates.some(value => value.status === 'ready')).toBe(false);
    h.tracker.stop();
  });

  it('recovers automatically on worker timeout but fails closed once on canvas-read exceptions', () => {
    vi.useFakeTimers();
    const h = harness(); h.tracker.start(); h.fire(1, 0);
    vi.advanceTimersByTime(10000);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(h.callbacks.size).toBe(1);
    h.fire(2, performance.now());
    expect(h.workers[1].jobs).toHaveLength(1);
    h.tracker.stop();
    const failing = harness(); failing.readFrame.mockImplementation(() => { throw new Error('Canvas unavailable'); });
    failing.tracker.start(); failing.fire(1, 0);
    expect(failing.onError).toHaveBeenCalledTimes(1);
    expect(failing.updates.at(-1)?.status).toBe('error');
    expect(failing.callbacks.size).toBe(0);
  });
});

describe('additional motion invalidation', () => {
  it('expires accepted geometry without preempting a newer in-flight job or erasing worker history', () => {
    vi.useFakeTimers();
    const h = harness(); h.tracker.start(); h.fire(1, 0); h.workers[0].finish();
    vi.advanceTimersByTime(1500); h.fire(2, performance.now());
    vi.advanceTimersByTime(1000);
    expect(h.updates.at(-1)).toMatchObject({ status: 'waiting', fresh: false, geometryStable: false, regions: [] });
    expect(h.workers[0].terminate).not.toHaveBeenCalled();
    h.fire(3, performance.now()); expect(h.workers[0].jobs).toHaveLength(2);
    vi.advanceTimersByTime(500); h.workers[0].finish(undefined, { processingMs: 1500 });
    expect(h.updates.at(-1)).toMatchObject({ status: 'ready', fresh: true, frame: { presentedFrames: 2 } });
    vi.advanceTimersByTime(1000); h.fire(4, performance.now()); h.workers[0].finish();
    expect(h.updates.at(-1)?.geometryStable).toBe(true);
    h.tracker.stop();
  });

  it('rejects over-budget worker duration as fresh proof and retries with empty history at lower resolution', () => {
    vi.useFakeTimers();
    const h = harness(); h.tracker.start(); h.fire(1, 0);
    const worker = h.workers[0], lateCallback = worker.onmessage!, job = worker.jobs[0];
    worker.finish(undefined, { processingMs: 2500 });
    expect(h.updates.at(-1)).toMatchObject({ status: 'waiting', fresh: false, geometryStable: false, regions: [], candidateRegions: [] });
    expect(h.onError).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(500); h.fire(2, performance.now());
    expect(h.workers[1].jobs[0].image).toMatchObject({ width: 320, height: 180 });
    expect(h.workers[1].jobs[0].generation).toBeGreaterThan(job.generation);
    h.workers[1].finish(); expect(h.updates.at(-1)?.geometryStable).toBe(false);
    lateCallback({ data: { id: job.id, generation: job.generation, frame: job.frame, tracking: computeTracking(null, detection(1, { frame: job.frame })).tracking } } as MessageEvent);
    expect(h.updates.at(-1)?.frame.presentedFrames).toBe(2);
    h.tracker.stop();
  });

  it('does not retain late worker history when a sequence change supersedes the pending request', () => {
    vi.useFakeTimers();
    const h = harness(); h.tracker.start(); h.fire(1, 0);
    const worker = h.workers[0];
    h.tracker.configure({ expectedSequence: 2 });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(3000);
    worker.finish();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(h.updates.at(-1)).toMatchObject({ status: 'waiting', fresh: false, regions: [], geometryStable: false });
    clock.mockRestore(); h.tracker.stop();
  });

  it('resets detector baseline and stability when analysis resolution changes with unchanged native dimensions', () => {
    const image = raster(320, 240);
    [[20, 20, 20], [120, 120, 120], [230, 230, 230]].forEach((rgb, i) => paint(image, 15 + i * 100, 85, 80, 50, rgb));
    let state: WorkerTrackingState | null = null;
    for (let i = 1; i <= 3; i++) state = processTrackingFrame(request(image, i, 'cards'), state);
    expect(state!.tracking.tracking.geometryStable).toBe(true);
    const smaller = raster(256, 192);
    [[20, 20, 20], [120, 120, 120], [230, 230, 230]].forEach((rgb, i) => paint(smaller, 12 + i * 80, 68, 64, 40, rgb));
    const next = processTrackingFrame({ ...request(smaller, 4, 'cards'), frame: { presentedFrames: 4, mediaTime: 2, width: 640, height: 480 } }, state);
    expect(next.tracking.tracking).toMatchObject({ geometryStable: false, pixelMoving: false, surfaceChanged: false, frame: { width: 640, height: 480 } });
    expect(next.tracking.tracking.evidence.motionSamples).toBe(0);
    expect(next.tracking.tracking.regions[0].polygon[0][0]).toBeGreaterThan(24);
  });

  it('explicitly resets baseline history without accepting an old in-flight frame or restarting a stopped tracker', () => {
    const h = harness(); h.tracker.start(); h.fire(1, 0); h.workers[0].finish();
    h.fire(2, 700);
    const oldWorker = h.workers[0], lateCallback = oldWorker.onmessage!, job = oldWorker.jobs.at(-1)!;
    h.tracker.resetBaseline();
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(h.updates.at(-1)).toMatchObject({ status: 'waiting', fresh: false, geometryStable: false, regions: [], moving: false });
    lateCallback({ data: { id: job.id, generation: job.generation, frame: job.frame, tracking: computeTracking(null, detection(2, { frame: job.frame })).tracking } } as MessageEvent);
    expect(h.updates.at(-1)?.status).toBe('waiting');
    h.fire(2, 1200);
    expect(h.workers).toHaveLength(1);
    h.fire(3, 1700);
    expect(h.workers[1].jobs[0].generation).toBeGreaterThan(job.generation);
    h.tracker.stop(); h.tracker.resetBaseline();
    expect(h.callbacks.size).toBe(0);
  });

  it('reacquires a deliberately replaced scene only after explicit reset and three fresh detections, then preserves it across the first command', () => {
    const h = harness(); h.tracker.configure({ phase: 'scene', expectedSequence: 1, mode: 'cameraMatch' });
    let image = scene();
    h.readFrame.mockImplementation(() => ({ ...image, data: new Uint8ClampedArray(image.data) }));
    const states = new Map<TrackingWorker, WorkerTrackingState>();
    const detect = (index: number) => {
      h.fire(index, (index - 1) * 1000);
      const worker = h.workers.at(-1)!, job = worker.jobs.at(-1)!;
      const state = processTrackingFrame(job, states.get(worker) ?? null); states.set(worker, state);
      worker.onmessage?.({ data: { id: job.id, generation: job.generation, frame: job.frame, tracking: state.tracking.tracking } } as MessageEvent);
    };
    h.tracker.start(); detect(1); detect(2); detect(3);
    expect(h.updates.at(-1)?.geometryStable).toBe(true);
    image = scene();
    const paintNewFabric = () => [[90, 135, 165], [100, 145, 175], [170, 90, 75]].forEach((rgb, i) => paint(image, 45, 80 + i * 70, 170, 70, rgb));
    paintNewFabric(); detect(4); detect(5);
    expect(h.updates.at(-1)).toMatchObject({ surfaceChanged: true, geometryStable: false });
    h.tracker.resetBaseline();
    detect(6); expect(h.updates.at(-1)).toMatchObject({ surfaceChanged: false, pixelMoving: false, geometryStable: false });
    detect(7); expect(h.updates.at(-1)?.geometryStable).toBe(false);
    detect(8); expect(h.updates.at(-1)).toMatchObject({ fresh: true, geometryStable: true, moving: false });
    h.tracker.configure({ expectedSequence: 2 });
    image = scene(2, [0, 0, 0]); paintNewFabric(); detect(9);
    expect(h.updates.at(-1)).toMatchObject({ expectedSequence: 2, geometryStable: true, surfaceChanged: false, pixelMoving: false });
    image = scene(2, [0, 0, 0]); detect(10);
    expect(h.updates.at(-1)).toMatchObject({ surfaceChanged: true, geometryStable: false });
    h.tracker.stop();
  }, 20000);

  it('detects coarse fabric texture changes against an immutable descriptor without exporting its samples', () => {
    let state: WorkerTrackingState | null = null;
    for (let i = 1; i <= 3; i++) state = processTrackingFrame(request(scene(), i), state);
    const changed = scene();
    for (let y = 80; y < 290; y++) for (let x = 45; x < 215; x++) {
      const offset = (y * changed.width + x) * 4;
      const delta = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 18 : -18;
      for (let c = 0; c < 3; c++) changed.data[offset + c] += delta;
    }
    const result = processTrackingFrame(request(changed, 4), state).tracking.tracking;
    expect(result).toMatchObject({ moving: true, surfaceChanged: true, geometryStable: false });
    expect(JSON.stringify(result)).not.toMatch(/descriptor|fingerprint|pixels|observedRgb/);
  });

  it('clears accepted cards immediately on phase or mode change, but sequence-only keeps the worker geometry history', () => {
    const h = harness(); h.tracker.start(); h.fire(1, 0); h.workers[0].finish();
    h.tracker.configure({ phase: 'scene', mode: 'cameraMatch', expectedSequence: 1 });
    expect(h.updates.at(-1)).toMatchObject({ phase: 'scene', status: 'waiting', expectedSequence: 1, fresh: false, regions: [] });
    h.fire(2, 600); h.workers[1].finish();
    h.tracker.configure({ expectedSequence: 2 });
    expect(h.updates.at(-1)).toMatchObject({ status: 'waiting', expectedSequence: 2, fresh: false, pixelMoving: false, regions: [] });
    expect(h.workers[1].terminate).not.toHaveBeenCalled();
    h.tracker.configure({ mode: 'threeStage' });
    expect(h.workers[1].terminate).toHaveBeenCalledOnce();
    expect(h.updates.at(-1)).toMatchObject({ status: 'waiting', fresh: false, regions: [] });
    h.tracker.stop();
  });

  it('returns bounded unconfirmed native candidate geometry and scalar diagnostics for incomplete cards', () => {
    const image = raster(320, 240);
    [[20, 20, 20], [120, 120, 120]].forEach((rgb, i) => paint(image, 15 + i * 100, 85, 80, 50, rgb));
    const result = processTrackingFrame(request(image, 1, 'cards'), null).tracking.tracking;
    expect(result.status).not.toBe('ready');
    expect(result.candidateRegions?.length).toBeGreaterThanOrEqual(2);
    expect(result.candidateRegions!.length).toBeLessThanOrEqual(12);
    result.candidateRegions!.forEach(r => { expect(r.polygon[0][1]).toBeGreaterThan(170); expect(r).toMatchObject({ selectionMethod: 'autoDetected', operatorConfirmed: false }); });
    expect(result.debug).toMatchObject({ reason: 'missingCardCandidates', matchingTriplets: 0 });
    expect(Object.values(result.debug!.rejections!)).toEqual(expect.arrayContaining([expect.any(Number)]));
    expect(JSON.stringify(result)).not.toMatch(/observedBrightness|observedRgb|pixels|descriptor/);
    expect(result.expectedSequence).toBe(1);
  });

  it('drops late work after 2500ms even if a delayed event loop delivers the result before its timeout', () => {
    vi.useFakeTimers();
    const h = harness(); h.tracker.start(); h.fire(1, 0);
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValue(9000);
    h.workers[0].finish();
    expect(h.updates.some(value => value.status === 'ready')).toBe(false);
    expect(h.updates.at(-1)).toMatchObject({ fresh: false, geometryStable: false, regions: [], pixelMoving: false });
    h.tracker.stop(); clock.mockRestore();
  });

  it('invalidates unchanged fabric boundaries when their appearance changes and never adopts the changed surface as its baseline', () => {
    let state: WorkerTrackingState | null = null;
    for (let i = 1; i <= 3; i++) state = processTrackingFrame(request(scene(), i), state);
    const initialPolygons = state!.tracking.tracking.regions.map(r => r.polygon);
    const changed = scene();
    [[90, 135, 165], [100, 145, 175], [170, 90, 75]].forEach((rgb, i) => paint(changed, 45, 80 + i * 70, 170, 70, rgb));
    const next = processTrackingFrame(request(changed, 4), state);
    expect(next.tracking.tracking.regions.map(r => r.polygon)).toEqual(initialPolygons);
    expect(next.tracking.tracking).toMatchObject({ moving: true, geometryStable: false, surfaceChanged: true });
    const repeated = processTrackingFrame(request(changed, 5), next);
    expect(repeated.tracking.tracking).toMatchObject({ geometryStable: false, surfaceChanged: true });
    const freshCommand = processTrackingFrame({ ...request(scene(2, [0, 0, 0]), 4, 'scene', 2), generation: 2 }, state);
    expect(freshCommand.tracking.tracking).toMatchObject({ geometryStable: true, pixelMoving: false, surfaceChanged: false });
  });
  it('keeps missing-marker fabric geometry visible but never retransmits an unlocalized screen as fabric',()=>{
    const target=scene();paint(target,0,300,640,35,[83,72,61]);
    const result=processTrackingFrame(request(target,1),null).tracking.tracking;
    expect(result.marker).toBeNull();expect(result.previewBands??[]).toHaveLength(0);
  });

  it('does not mask right-side background once the opaque screen is recognized', () => {
    const state = processTrackingFrame(request(scene(), 1), null);
    const changed = scene(); paint(changed, 320, 340, 300, 120, [170, 170, 170]);
    expect(processTrackingFrame(request(changed, 2), state).tracking.tracking).toMatchObject({ pixelMoving: true, moving: true, geometryStable: false });
  });

  it('invalidates marker displacement even with unchanged region polygons', () => {
    const prior = computeTracking(null, detection(1, { phase: 'scene', marker: { x: 400, y: 300, width: 280, height: 20 } }));
    expect(computeTracking(prior, detection(2, { phase: 'scene', marker: { x: 420, y: 300, width: 280, height: 20 } })).tracking.moving).toBe(true);
  });
  it('retains native identity order and previous motion fingerprint when detection configuration changes', () => {
    const prior = processTrackingFrame(request(raster(), 1), null);
    const moved = raster(); paint(moved, 0, 0, 260, 480, [170, 170, 170]);
    const result = processTrackingFrame({ ...request(moved, 2), generation: 2, expectedSequence: 3 }, prior);
    expect(result.tracking.tracking.moving).toBe(true);
    expect(processTrackingFrame(request(raster(), 1), prior)).toBe(prior);
  });
  it('keeps confirmed geometry across fresh command sequences but not across phase or mode changes', () => {
    let state: WorkerTrackingState | null = null;
    for (let i = 1; i <= 3; i++) state = processTrackingFrame(request(scene(), i), state);
    expect(state!.tracking.tracking.geometryStable).toBe(true);
    const command = processTrackingFrame({ ...request(scene(2, [255, 255, 255]), 4, 'scene', 2), generation: 2 }, state);
    expect(command.tracking.tracking).toMatchObject({ geometryStable: true, moving: false });
    const mode = processTrackingFrame({ ...request(scene(2), 5, 'scene', 2), generation: 3, mode: 'threeStage' }, command);
    expect(mode.tracking.tracking.geometryStable).toBe(false);
  });

  it('resets both appearance and pixel history when the tracking mode changes', () => {
    const state = processTrackingFrame(request(scene(), 1), null);
    const changed = scene(); paint(changed, 0, 0, 280, 480, [190, 100, 130]);
    const reset = processTrackingFrame({ ...request(changed, 2), generation: 2, mode: 'threeStage' }, state);
    expect(reset.tracking.tracking).toMatchObject({ pixelMoving: false, surfaceChanged: false, geometryStable: false });
    expect(reset.tracking.tracking.evidence.motionSamples).toBe(0);
  });
});
