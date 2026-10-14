import { describe, expect, it, vi } from 'vitest';
import { markerCells } from './marker';
import { newRegion } from './regions';
import type { Frame } from './sampling';
import { runResponseGuide } from './responseGuide';

function fixture() {
  const signal = new AbortController();
  const screen = { ...newRegion([[0, 0], [20, 0], [20, 20], [0, 20]], 1), id: 'screen', selectionMethod: 'autoDetected' as const, operatorConfirmed: false };
  const card = { ...screen, id: 'gray', polygon: [[30, 0], [50, 0], [50, 20], [30, 20]] as [number, number][] };
  const step = (sequence: number) => ({ runId: 'run', status: 'running', nextDrive: [.5, .5, .5], phase: sequence === 1 ? 'train' : 'holdout', step: sequence, totalSteps: 2, patchId: `p${sequence}`, commandSequence: sequence });
  const profile = { status: 'cameraReferencedExperimental', referenceValuesKnown: false, physicalAccuracyVerified: false, validation: { metric: 'normalizedCameraRgbEuclidean', holdout: { mean: .003, max: .005 } } };
  const order: string[] = [];
  const post = vi.fn(async (route: string, _body: unknown): Promise<unknown> => { order.push(route); return route.endsWith('/start') ? step(1) : route.endsWith('/observe') && post.mock.calls.length === 2 ? step(2) : { runId: 'run', status: 'complete', nextDrive: null, responseProfile: profile }; });
  const capture = vi.fn(async (command: { commandSequence?: number }) => {
    if (!command.commandSequence) throw new Error('missing sequence');
    const sequence = command.commandSequence;
    order.push(`capture${command.commandSequence}`);
    return [screen, card].map((region, roiIndex) => Array.from({ length: 10 }, (_, i) => ({ id: `${sequence}-${roiIndex}-${i}`, capturedAt: sequence * 2000 + i * 120, presentedFrames: sequence * 20 + i, mediaTime: 0, width: 80, height: 40, settingsFingerprint: 'fp', markerSequence: sequence, markerPixels: markerCells(sequence).map(v => [v, v, v]), source: 'videoCanvas', colorSpace: 'srgb', encoding: 'encoded', regionId: region.id, roi: region.polygon.map(([x, y]) => [x / 80, y / 40]), exclusions: [], pixels: Array.from({ length: 16 }, () => [.3, .3, .3]), blockIds: Array.from({ length: 16 }, (_, j) => Math.floor(j / 4)), pixelCount: 400, excludedCount: 0 })) as Frame[]);
  });
  const geometry = vi.fn(async () => { order.push('geometry'); return { screen, card, marker: { x: 0, y: 30, width: 28, height: 4 }, referenceRole: 'middle' as const }; });
  const wait = vi.fn(async (command: { commandSequence?: number }) => { order.push(`ack${command.commandSequence}`); });
  const cancel = vi.fn(async (_runId: string) => {});
  const ports = { post, capture, geometry, wait, cancel, fingerprint: () => 'fp', context: { fingerprint: 'fp', width: 80, height: 40, streamId: 'response-stream-id' }, signal: signal.signal, progress: vi.fn() };
  return { ports, signal, profile, order, post, capture, cancel };
}
describe('measured response guide', () => {
  it('starts the server command before geometry, waits each render ACK and sends real co-captured zero-clock screen/card batches', async () => {
    const f = fixture();
    expect(await runResponseGuide(f.ports)).toEqual(f.profile);
    expect(f.order).toEqual(['response-profile/start', 'ack1', 'geometry', 'capture1', 'response-profile/run/observe', 'ack2', 'geometry', 'capture2', 'response-profile/run/observe']);
    expect(f.post.mock.calls[1][1]).toMatchObject({ fingerprint: 'fp', width: 80, height: 40, referenceRole: 'middle', phase: 'train', commandSequence: 1 });
    expect(f.post.mock.calls[1][1]).not.toHaveProperty('nominalLab');
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it('requires current geometry on every color step and rejects a replacement witness before the next capture',async()=>{
    const f=fixture(),original=f.ports.geometry.getMockImplementation()!;
    f.ports.geometry.mockImplementation(async()=>{const geometry=await original();return f.ports.geometry.mock.calls.length>1?{...geometry,card:{...geometry.card,id:'other-card'}}:geometry;});
    await expect(runResponseGuide(f.ports)).rejects.toThrow('شاهد');
    expect(f.capture).toHaveBeenCalledOnce();expect(f.cancel).toHaveBeenCalledExactlyOnceWith('run');
  });
  it('cancels a partial run without posting observations when any native ROI changes mid-batch', async () => {
    const f = fixture(); const capture = f.capture.getMockImplementation()!;
    f.capture.mockImplementation(async command => { const frames = await capture(command); frames[0][5].roi = [[.7, .7], [.9, .7], [.9, .9], [.7, .9]]; return frames; });
    await expect(runResponseGuide(f.ports)).rejects.toThrow('هندسه');
    expect(f.post).toHaveBeenCalledOnce(); expect(f.cancel).toHaveBeenCalledExactlyOnceWith('run');
  });
  it('rejects a mismatching physical marker without an observe POST', async () => {
    const f = fixture(), capture = f.capture.getMockImplementation()!;
    f.capture.mockImplementation(async command => { const frames = await capture(command); frames[1][2].markerPixels = markerCells(99).map(v => [v, v, v]); return frames; });
    await expect(runResponseGuide(f.ports)).rejects.toThrow('نشانگر');
    expect(f.post).toHaveBeenCalledOnce(); expect(f.cancel).toHaveBeenCalledExactlyOnceWith('run');
  });
  it('cancels failed partial capture and never reports an unvalidated completion', async () => {
    const f = fixture(); f.capture.mockRejectedValue(new Error('unstable'));
    await expect(runResponseGuide(f.ports)).rejects.toThrow('unstable');
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith('run');
    const g = fixture(); g.post.mockResolvedValue({ runId: 'run', status: 'complete', nextDrive: null, responseProfile: { status: 'cameraReferencedExperimental' } });
    await expect(runResponseGuide(g.ports)).rejects.toThrow('اعتبارسنجی');
    expect(g.cancel).toHaveBeenCalledExactlyOnceWith('run');
  });
  it('ignores a late observe response after abort and cancels without advancing to another step', async () => {
    const f = fixture(); let release!: (value: unknown) => void;
    const post = f.post.getMockImplementation()!;
    f.post.mockImplementation((route, body) => route.endsWith('/observe') ? new Promise(resolve => { release = resolve; }) : post(route, body));
    const pending = runResponseGuide(f.ports); const rejected = expect(pending).rejects.toThrow('متوقف');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.signal.abort(); await rejected;
    release({ runId: 'run', status: 'complete', nextDrive: null, responseProfile: f.profile });
    await Promise.resolve(); expect(f.capture).toHaveBeenCalledOnce(); expect(f.cancel).toHaveBeenCalledExactlyOnceWith('run');
  });
  it('cancels even a late start result after abort rather than leaving an orphan run', async () => {
    const f = fixture(); let release!: (value: unknown) => void;
    f.post.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = runResponseGuide(f.ports); const rejected = expect(pending).rejects.toThrow('متوقف');
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); f.signal.abort(); await rejected;
    release({ runId: 'late', status: 'running' }); await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledWith('late'));
    expect(f.capture).not.toHaveBeenCalled();
  });
  it('stops on a fingerprint change before submitting captured observations', async () => {
    const f = fixture(); let fingerprint = 'fp'; f.ports.fingerprint = () => fingerprint;
    const capture = f.capture.getMockImplementation()!;
    f.capture.mockImplementation(async command => { const frames = await capture(command); fingerprint = 'changed'; return frames; });
    await expect(runResponseGuide(f.ports)).rejects.toThrow('تنظیمات');
    expect(f.post).toHaveBeenCalledOnce(); expect(f.cancel).toHaveBeenCalledExactlyOnceWith('run');
  });
});
