import { describe, expect, it, vi } from 'vitest';
import { Camera, collectFrames, collectRelativeFrames, readCanvasPixels, verifyCanvas, verifyCameraPath } from './camera';
import { markerCells } from './marker';
import type { Region } from './sampling';

describe('real rear camera and honest controls', () => {
  it('requests no audio, fixes selected device and keeps requested/capabilities/settings separate', async () => {
    const track = { getSettings: () => ({ deviceId: 'rear', width: 1920 }), getCapabilities: () => ({ exposureMode: ['manual'] }), stop: vi.fn(), addEventListener: vi.fn(), applyConstraints: vi.fn().mockResolvedValue(undefined) };
    const getUserMedia = vi.fn().mockResolvedValue({ getVideoTracks: () => [track], getTracks: () => [track] });
    const media = { getUserMedia, getSupportedConstraints: () => ({ exposureMode: true, deviceId: true }) };
    const camera = new Camera(media as never, vi.fn());
    await camera.start('rear'); await camera.controls({ exposureMode: 'manual' });
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({ audio: false, video: { deviceId: { exact: 'rear' } } });
    expect(camera.report()).toMatchObject({ browserSupported: true, supportedConstraints: { exposureMode: true }, trackCapabilities: { exposureMode: ['manual'] }, reportedSettings: { deviceId: 'rear', width: 1920 }, controlStatus: { manualLock: 'unknown' } });
    expect(camera.fingerprint().length).toBeLessThanOrEqual(128);
    expect(camera.report().requested).not.toEqual(camera.report().reportedSettings);
    camera.stop(); expect(track.stop).toHaveBeenCalled();
  });
  it('reports track end as a pause/invalidation reason', async () => {
    let end = () => {}; const pause = vi.fn();
    const track = { getSettings: () => ({}), getCapabilities: () => ({}), addEventListener: (_: string, f: () => void) => { end = f; }, stop: vi.fn() };
    const c = new Camera({ getSupportedConstraints: () => ({}), getUserMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) } as never, pause);
    await c.start(); end(); expect(pause).toHaveBeenCalledWith('camera_track_ended');
  });
});

describe('auto exposure / white balance lock', () => {
  const caps = { exposureMode: ['continuous', 'manual'], exposureTime: { min: 1, max: 1000 }, iso: { min: 50, max: 1600 }, whiteBalanceMode: ['continuous', 'manual'], colorTemperature: { min: 2000, max: 9000 } };
  // A fake track whose applyConstraints really changes what getSettings reports, like a cooperative browser.
  function setup(opts: { capabilities?: Record<string, unknown>; settings?: Record<string, unknown>; reflect?: boolean; reject?: string } = {}) {
    const settings: Record<string, unknown> = opts.settings ?? { exposureMode: 'continuous', exposureTime: 120, iso: 200, whiteBalanceMode: 'continuous', colorTemperature: 4300 };
    const applyConstraints = vi.fn(async (c: { advanced: Record<string, unknown>[] }) => {
      if (opts.reject && opts.reject in c.advanced[0]) throw new Error('OverconstrainedError');
      if (opts.reflect !== false) Object.assign(settings, c.advanced[0]);
    });
    const track = { getSettings: () => ({ ...settings }), getCapabilities: () => opts.capabilities ?? caps, stop: vi.fn(), addEventListener: vi.fn(), applyConstraints };
    const pause = vi.fn();
    const camera = new Camera({ getSupportedConstraints: () => ({}), getUserMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) } as never, pause);
    return { camera, applyConstraints, pause };
  }
  it('pins exposure and white balance at their current values, verifies by read-back and never pauses the session', async () => {
    const { camera, applyConstraints, pause } = setup();
    await camera.start();
    const before = camera.fingerprint();
    const result = await camera.lockAuto();
    expect(result).toMatchObject({ status: 'locked', applied: ['exposure', 'whiteBalance'], unverified: [], unsupported: [], failed: [] });
    expect(applyConstraints.mock.calls.map(call => call[0].advanced[0])).toEqual([
      { exposureMode: 'manual', exposureTime: 120, iso: 200 },
      { whiteBalanceMode: 'manual', colorTemperature: 4300 },
    ]);
    expect(camera.report().controlStatus.manualLock).toBe('locked');
    expect(camera.fingerprint()).not.toBe(before);
    expect(pause).not.toHaveBeenCalled();
    camera.stop(); expect(camera.report().controlStatus.manualLock).toBe('unknown');
  });
  it('does not lock a bare manual mode when the current numeric value is unknown, and says unsupported', async () => {
    const { camera, applyConstraints } = setup({ settings: { exposureMode: 'continuous', whiteBalanceMode: 'continuous' } });
    await camera.start();
    expect(await camera.lockAuto()).toMatchObject({ status: 'unsupported', unsupported: ['exposure', 'whiteBalance'] });
    expect(applyConstraints).not.toHaveBeenCalled();
  });
  it('never claims a lock the browser does not report back', async () => {
    const { camera } = setup({ reflect: false });
    await camera.start();
    expect(await camera.lockAuto()).toMatchObject({ status: 'unverified', applied: [], unverified: ['exposure', 'whiteBalance'] });
    expect(camera.report().controlStatus.manualLock).toBe('unverified');
  });
  it('keeps the other group when the browser rejects one', async () => {
    const { camera } = setup({ reject: 'exposureMode' });
    await camera.start();
    expect(await camera.lockAuto()).toMatchObject({ status: 'partial', applied: ['whiteBalance'], failed: ['exposure'] });
  });
  it('requires an active camera', async () => {
    await expect(new Camera({} as never, vi.fn()).lockAuto()).rejects.toThrow();
  });
});

describe('verified float canvas and fresh frame collection', () => {
  it('checks returned colorSpace and actual float data rather than request alone', () => {
    const ctx = { getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(16), colorSpace: 'srgb' })) };
    expect(() => readCanvasPixels(ctx as never, { x: 0, y: 0, width: 2, height: 2 }, 'srgb')).toThrow('float');
    const ctx2 = { getImageData: vi.fn(() => ({ data: new Float32Array(16), colorSpace: 'display-p3' })) };
    expect(() => readCanvasPixels(ctx2 as never, { x: 0, y: 0, width: 2, height: 2 }, 'srgb')).toThrow('فضای');
  });
  it('verifies requested canvas path before reference and exposes getConstraints separately', () => {
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => ({ getImageData: () => ({ data: new Float32Array(16), colorSpace: 'srgb', width: 2, height: 2 }) })) };
    expect(verifyCanvas(canvas as never, 'srgb')).toBe('srgb');
    expect(canvas.getContext).toHaveBeenCalledWith('2d', expect.objectContaining({ colorSpace: 'srgb' }));
  });
  it('rejects actual canvas backing space different from requested space before pixels are drawn', () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ getContextAttributes: () => ({ colorSpace: 'srgb' }), getImageData: () => ({ data: new Float32Array(16), colorSpace: 'display-p3', width: 2, height: 2 }) }) };
    expect(() => verifyCanvas(canvas as never, 'display-p3')).toThrow('backing');
  });
  it('releases real camera tracks when the verified capture path is unavailable', () => {
    const camera = { stop: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => null };
    expect(() => verifyCameraPath(camera as never, canvas as never, 'srgb')).toThrow();
    expect(camera.stop).toHaveBeenCalled();
  });
  const r: Region = { id: 'r', label: 'r', order: 1, mode: 'solid', polygon: [[0, 0], [8, 0], [8, 8], [0, 8]], exclusions: [], background: null, direction: null, layers: null, operatorConfirmed: false };
  it('co-captures experimental screen and gray card with actual zero mediaTime, native geometry and distinct presented frames', async () => {
    const callbacks: ((now: number, metadata: { presentedFrames: number; mediaTime: number }) => void)[] = [];
    const video = { requestVideoFrameCallback: (fn: typeof callbacks[number]) => { callbacks.push(fn); return 1; }, cancelVideoFrameCallback: vi.fn() };
    const card = { ...r, id: 'gray', polygon: r.polygon.map(([x, y]) => [x + 16, y] as [number, number]) };
    const read = vi.fn(async () => ({ markerPixels: markerCells(8).map(v => [v, v, v]), images: [r, card].map(() => ({ data: new Float32Array(256).fill(.3), width: 8, height: 8 })), offsets: [{ x: 0, y: 0 }, { x: 16, y: 0 }], width: 80, height: 40, colorSpace: 'srgb' as const, fingerprint: 'fixed' }));
    const sample = vi.fn().mockResolvedValue({ pixels: [[.3, .3, .3]], blockIds: [1], pixelCount: 64, excludedCount: 0 });
    const pending = collectRelativeFrames(video as never, [r, card], read, sample, new AbortController().signal, 8);
    for (let i = 0; i < 10; i++) { callbacks.shift()!(i * 120, { presentedFrames: i + 1, mediaTime: 0 }); await new Promise(resolve => setTimeout(resolve, 0)); }
    const [screen, gray] = await pending;
    expect(screen).toHaveLength(10); expect(gray).toHaveLength(10); expect(read).toHaveBeenCalledTimes(10);
    expect(screen.every(f => f.mediaTime === 0)).toBe(true);
    expect(new Set(screen.map(f => f.presentedFrames)).size).toBe(10);
    expect(screen.map(f => [f.presentedFrames, f.mediaTime, f.capturedAt])).toEqual(gray.map(f => [f.presentedFrames, f.mediaTime, f.capturedAt]));
    expect(screen[0]).toMatchObject({ width: 80, height: 40, markerSequence: 8, roi: [[0, 0], [.1, 0], [.1, .2], [0, .2]] });
    expect(gray[0].roi).toEqual([[.2, 0], [.3, 0], [.3, .2], [.2, .2]]);
  });
  it('explains a frozen media clock promptly instead of hanging scientific capture until timeout',async()=>{
    const callbacks:((now:number,metadata:{presentedFrames:number;mediaTime:number})=>void)[]=[];
    const video={requestVideoFrameCallback:(fn:typeof callbacks[number])=>{callbacks.push(fn);return callbacks.length;},cancelVideoFrameCallback:vi.fn()};
    const read=async()=>({images:[{data:new Float32Array(256).fill(.3),width:8,height:8}],offsets:[{x:0,y:0}],colorSpace:'srgb' as const,fingerprint:'f'});
    const sample=vi.fn().mockResolvedValue({pixels:[[.3,.3,.3]],blockIds:[1],pixelCount:64,excludedCount:0});
    const promise=collectFrames(video as never,[r],read,sample,new AbortController().signal);
    const rejected=expect(promise).rejects.toThrow('زمان ویدئو');
    for(let i=0;i<5;i++){const callback=callbacks.shift();if(!callback)break;callback(i*120,{presentedFrames:i+1,mediaTime:0});await new Promise(resolve=>setTimeout(resolve,0));}
    await rejected;
  });
  it('permits only the documented zero-clock exception, not an arbitrary frozen nonzero clock', async () => {
    const callbacks: ((now: number, metadata: { presentedFrames: number; mediaTime: number }) => void)[] = [];
    const video = { requestVideoFrameCallback: (fn: typeof callbacks[number]) => { callbacks.push(fn); return 1; }, cancelVideoFrameCallback: vi.fn() };
    const read = async () => ({ markerPixels: markerCells(3).map(v => [v, v, v]), images: [{ data: new Float32Array(256).fill(.3), width: 8, height: 8 }], offsets: [{ x: 0, y: 0 }], colorSpace: 'srgb' as const, fingerprint: 'fixed' });
    const sample = vi.fn().mockResolvedValue({ pixels: [[.3, .3, .3]], blockIds: [1], pixelCount: 64, excludedCount: 0 });
    const abort = new AbortController();
    const pending = collectRelativeFrames(video as never, [r], read, sample, abort.signal, 3);
    const rejected = expect(pending).rejects.toThrow('زمان ویدئو');
    callbacks.shift()!(0, { presentedFrames: 1, mediaTime: 1 }); await new Promise(resolve => setTimeout(resolve, 0));
    callbacks.shift()!(120, { presentedFrames: 2, mediaTime: 1 }); await new Promise(resolve => setTimeout(resolve, 0));
    if (callbacks.length) abort.abort();
    await rejected;
  });
  it('takes ten unique video callbacks spanning a second with physical marker before worker sampling', async () => {
    const callbacks: ((now: number, metadata: { presentedFrames: number; mediaTime: number }) => void)[] = [];
    const video = { requestVideoFrameCallback: (f: typeof callbacks[number]) => { callbacks.push(f); return callbacks.length; }, cancelVideoFrameCallback: vi.fn() };
    const order: string[] = [];
    const read = vi.fn(async () => { order.push('marker'); return { markerPixels: markerCells(3).map(v => [v, v, v]), images: [{ data: new Float32Array(256).fill(0.3), width: 8, height: 8 }], offsets: [{ x: 0, y: 0 }], colorSpace: 'srgb' as const, fingerprint: 'fixed' }; });
    const sample = vi.fn(async () => { order.push('sample'); return { pixels: [[0.3, 0.3, 0.3]], blockIds: [1], pixelCount: 64, excludedCount: 0 }; });
    const promise = collectFrames(video as never, [r], read, sample, new AbortController().signal, 3);
    for (let i = 0; i < 10; i++) { callbacks.shift()!(i * 120, { presentedFrames: i + 1, mediaTime: i * 0.12 }); await new Promise(resolve => setTimeout(resolve, 0)); }
    const frames = (await promise)[0];
    expect(frames).toHaveLength(10); expect(new Set(frames.map(f => f.id)).size).toBe(10);
    expect(frames[9].capturedAt - frames[0].capturedAt).toBeGreaterThanOrEqual(1000);
    expect(order.slice(0, 2)).toEqual(['marker', 'sample']); expect(frames[0].markerSequence).toBe(3);
    expect(frames[0]).toMatchObject({ presentedFrames: 1, mediaTime: 0, width: 8, height: 8, regionId: 'r', roi: [[0, 0], [1, 0], [1, 1], [0, 1]], sharpnessStatus: 'notAssessed' });
  });
  it('rejects stale physical sequence before sampling any color', async () => {
    let callback!: (now: number, metadata: { presentedFrames: number; mediaTime: number }) => void;
    const video = { requestVideoFrameCallback: (f: typeof callback) => { callback = f; return 1; }, cancelVideoFrameCallback: vi.fn() };
    const sample = vi.fn();
    const promise = collectFrames(video as never, [r], async () => ({ markerPixels: markerCells(2).map(v => [v, v, v]), images: [], offsets: [], colorSpace: 'srgb', fingerprint: 'f' }), sample, new AbortController().signal, 3);
    callback(0, { presentedFrames: 1, mediaTime: 0 });
    await expect(promise).rejects.toThrow('نشانگر'); expect(sample).not.toHaveBeenCalled();
  });
  it('does not permit marker pixels to overlap a measurement ROI', async () => {
    const { assertSeparated } = await import('./camera');
    expect(() => assertSeparated([r], { x: 0, y: 0, width: 112, height: 8 })).toThrow('نشانگر');
    expect(() => assertSeparated([r], { x: 0, y: 30, width: 112, height: 8 })).not.toThrow();
  });
  it('rejects regressing actual video identities despite distinct callback timestamps', async () => {
    let callback!: (now: number, metadata: { presentedFrames: number; mediaTime: number }) => void;
    const video = { requestVideoFrameCallback: (f: typeof callback) => { callback = f; return 1; }, cancelVideoFrameCallback: vi.fn() };
    const read = async () => ({ images: [{ data: new Float32Array(256).fill(0.3), width: 8, height: 8 }], offsets: [{ x: 0, y: 0 }], colorSpace: 'srgb' as const, fingerprint: 'f' });
    const sample = vi.fn().mockResolvedValue({ pixels: [[0.3, 0.3, 0.3]], blockIds: [1], pixelCount: 64, excludedCount: 0 });
    const abort = new AbortController(); const promise = collectFrames(video as never, [r], read, sample, abort.signal);
    callback(100, { presentedFrames: 2, mediaTime: 0.2 }); await new Promise(resolve => setTimeout(resolve, 0));
    callback(220, { presentedFrames: 1, mediaTime: 0.1 });
    await expect(promise).rejects.toThrow('تازه');
  });
});
