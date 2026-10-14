import { describe, expect, it, vi } from 'vitest';
import { nextLiveRequirement, runLiveAutomation, runCameraMatchQueue, type LiveContext, type LivePorts } from './liveAutomation';
import { newRegion } from './regions';
import type { Frame } from './sampling';

const region = (id: string, order: number) => ({ ...newRegion([[order * 20, 0], [order * 20 + 10, 0], [order * 20 + 10, 10], [order * 20, 10]], order), id, label: id, operatorConfirmed: true });
const reference = { id: 'physical', source: 'operator instrument', version: '1', label: 'card', validity: 'verified' as const, valueType: 'Lab' as const, referenceWhite: 'D50' as const, observer: '2' as const, xyzScale: 1 as const, geometry: null, health: null, patches: [{ id: 'a', values: [50, 0, 0] as [number, number, number], neutral: true, split: 'train' as const }, { id: 'b', values: [60, 20, 0] as [number, number, number], neutral: false, split: 'holdout' as const }] };
function fixture() {
  const abort = new AbortController();
  const context: LiveContext = { mode: 'threeStage', snapshot: { state: 'camera', paused: false, profileVersion: 1, references: reference, capabilities: { display: {} } }, cameraReady: true, reference, regions: [region('ref-a', 1), region('ref-b', 2), region('display', 3), region('neutral', 4), region('card', 5), region('sample-2', 7), region('sample-1', 6)], bindings: { a: 'ref-a', b: 'ref-b' }, roles: { display: 'display', witness: 'neutral', card: 'card', fabric: 'sample-1' }, marker: { x: 0, y: 20, width: 28, height: 2 }, cardPatchId: 'a', width: 640, height: 480 };
  const events: string[] = [];
  const capture = vi.fn(async (regions: ReturnType<typeof region>[], signal: AbortSignal) => { expect(signal).toBe(abort.signal); events.push(`capture:${regions.map(r => r.id).join(',')}`); return regions.map(r => [{ id: r.id, colorSpace: 'srgb' }] as Frame[]); });
  const ports: LivePorts = { getContext: () => context, readServer: vi.fn(async () => context.snapshot), capture, fingerprint: () => 'real-settings', post: vi.fn(async (route, body) => { events.push(route); if (route === 'camera-profile') { context.snapshot = { ...context.snapshot, state: 'display', cameraProfile: { status: 'referenced' }, profileVersion: 2 }; return context.snapshot.cameraProfile!; } const id = (body as { region: { id: string } }).region.id; return { id: `m-${id}`, captureQuality: 'accepted', quality: { status: 'accepted' }, catalogStatus: 'referenced' }; }), grid: vi.fn(async signal => { expect(signal).toBe(abort.signal); events.push('grid'); context.snapshot = { ...context.snapshot, state: 'fabric', displayProfile: { status: 'model-valid' }, profileVersion: 3 }; return context.snapshot.displayProfile!; }), match: vi.fn(async (id, fabric, signal) => { expect(signal).toBe(abort.signal); events.push(`match:${id}:${fabric.id}`); return { status: 'complete', nextDrive: null }; }), progress: vi.fn(), item: vi.fn(), signal: abort.signal };
  return { context, ports, abort, events };
}
describe('bounded live workflow orchestration', () => {
  it('fits actual co-captured reference then grid then ordered fabric then matches the exact fabric closure', async () => {
    const { ports, events } = fixture();
    const rows = await runLiveAutomation(ports);
    expect(events).toEqual(['capture:ref-a,ref-b', 'camera-profile', 'grid', 'capture:sample-1,neutral,card', 'measurements', 'capture:sample-2,neutral,card', 'measurements', 'match:m-sample-1:sample-1', 'match:m-sample-2:sample-2']);
    expect(rows.map(r => [r.regionId, r.status])).toEqual([['sample-1', 'complete'], ['sample-2', 'complete']]);
  });
  it('uses current server state to reuse profiles and never repeats their captures', async () => {
    const { ports, context } = fixture();
    context.snapshot = { ...context.snapshot, state: 'fabric', cameraProfile: { status: 'referenced' }, displayProfile: { status: 'model-valid' } };
    await runLiveAutomation(ports);
    expect(ports.grid).not.toHaveBeenCalled();
    expect(ports.post).toHaveBeenCalledTimes(2);
    expect(ports.capture).toHaveBeenCalledTimes(2);
  });
  it('reports only the next missing prerequisite and never invents references or display connection', async () => {
    const { ports, context } = fixture();
    context.cameraReady = false; context.reference = null; context.snapshot.references = null;
    expect(nextLiveRequirement(context)?.id).toBe('camera');
    context.cameraReady = true;
    expect(nextLiveRequirement(context)?.id).toBe('reference');
    await expect(runLiveAutomation(ports)).rejects.toThrow(/مرجع/);
    expect(ports.capture).not.toHaveBeenCalled();
    context.reference = reference; context.snapshot.references = reference; context.bindings.b = 'ref-a';
    expect(nextLiveRequirement(context)?.id).toBe('bindings');
    context.bindings.b = 'ref-b'; context.snapshot.capabilities = {};
    expect(nextLiveRequirement(context)?.id).toBe('display');
  });
  it('never begins paused and never resumes or attests conditions itself', async () => {
    const { ports, context } = fixture(); context.snapshot.paused = true;
    await expect(runLiveAutomation(ports)).rejects.toThrow(/شاهد و شرایط/);
    expect(ports.post).not.toHaveBeenCalled(); expect(ports.capture).not.toHaveBeenCalled();
  });
  it('never falls back to a stale client reference after server clears it', async () => {
    const { context } = fixture(); context.snapshot.references = null;
    expect(nextLiveRequirement(context)?.id).toBe('reference');
  });
  it('retains rejected samples, skips their matches and keeps valid order', async () => {
    const { ports, context } = fixture(); context.snapshot = { ...context.snapshot, state: 'fabric', cameraProfile: {}, displayProfile: {} };
    ports.post = vi.fn().mockResolvedValueOnce({ id: 'bad', captureQuality: 'rejected', quality: { status: 'rejected' }, catalogStatus: 'rejected' }).mockResolvedValueOnce({ id: 'good', captureQuality: 'accepted', quality: { status: 'accepted' }, catalogStatus: 'referenced' });
    const rows = await runLiveAutomation(ports);
    expect(rows[0]).toMatchObject({ status: 'rejected', measurement: { id: 'bad' } });
    expect(ports.match).toHaveBeenCalledOnce(); expect(ports.match).toHaveBeenCalledWith('good', expect.objectContaining({ id: 'sample-2' }), ports.signal);
  });
  it.each(['readServer', 'capture', 'post', 'grid', 'match'] as const)('aborts centrally during %s await with no subsequent operation', async phase => {
    const { ports, context, abort, events } = fixture();
    if (phase === 'match') context.snapshot = { ...context.snapshot, state: 'fabric', cameraProfile: {}, displayProfile: {} };
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: (value: never) => void;
    const pending = new Promise<never>(resolve => { release = resolve; });
    const original = ports[phase];
    (ports as unknown as Record<string, unknown>)[phase] = vi.fn(() => { entered(); return pending; });
    const running = runLiveAutomation(ports); await started; abort.abort();
    await expect(running).rejects.toThrow(/متوقف/);
    const count = events.length; release({} as never); await Promise.resolve(); await Promise.resolve();
    expect(events).toHaveLength(count); expect(original).not.toHaveBeenCalled();
  });
  it('stops when latest server pause arrives after fitting rather than trusting the old snapshot', async () => {
    const { ports, context } = fixture();
    ports.readServer = vi.fn().mockImplementation(async () => context.snapshot).mockImplementationOnce(async () => context.snapshot).mockImplementationOnce(async () => ({ ...context.snapshot, paused: true }));
    await expect(runLiveAutomation(ports)).rejects.toThrow(/متوقف/);
    expect(ports.grid).not.toHaveBeenCalled();
  });
  it('does not reuse profiles whose scientific server stage is still reference', async () => {
    const { ports, context } = fixture(); context.snapshot = { ...context.snapshot, state: 'reference', cameraProfile: {}, displayProfile: {} };
    await expect(runLiveAutomation(ports)).rejects.toThrow(/ترتیب/);
    expect(ports.capture).not.toHaveBeenCalled();
  });
  it('does not make another capture after server invalidates the profiles mid sample queue', async () => {
    const { ports, context } = fixture(); context.snapshot = { ...context.snapshot, state: 'fabric', cameraProfile: {}, displayProfile: {} };
    const post = ports.post;
    ports.post = vi.fn(async (route, body) => { const result = await post(route, body); context.snapshot = { ...context.snapshot, state: 'reference', cameraProfile: undefined, displayProfile: undefined }; return result; });
    await expect(runLiveAutomation(ports)).rejects.toThrow(/پروفایل/);
    expect(ports.capture).toHaveBeenCalledOnce();
  });
  it('preserves explicit catalogOnly and replay routes', async () => {
    const { ports, context } = fixture(); context.mode = 'catalogOnly'; context.cardPatchId = 'a';
    context.snapshot = { ...context.snapshot, state: 'fabric', cameraProfile: {} };
    await runLiveAutomation(ports); expect(ports.match).not.toHaveBeenCalled(); expect(ports.grid).not.toHaveBeenCalled();
    context.mode = 'replay'; await expect(runLiveAutomation(ports)).rejects.toThrow(/بازپخش/);
  });
  it('runs explicit no-card camera matching sequentially with machine geometry never human confirmed', async () => {
    const { ports, context, events } = fixture(); context.mode = 'cameraMatch'; context.reference = null;
    context.snapshot = { state: 'fabric', paused: false, profileVersion: 0, capabilities: { display: {} } };
    context.regions = context.regions.filter(r => ['display', 'sample-1', 'sample-2'].includes(r.id)).map(r => ({ ...r, operatorConfirmed: false, selectionMethod: 'autoDetected' })); context.bindings = {}; context.roles.witness = ''; context.roles.card = '';
    const match = vi.fn(async (region, _frames, signal) => { expect(signal).toBe(ports.signal); events.push(`camera-match:${region.id}`); return { status: 'complete' }; });
    const rows = await runCameraMatchQueue({ ...ports, match });
    expect(events).toEqual(['capture:sample-1', 'camera-match:sample-1', 'capture:sample-2', 'camera-match:sample-2']);
    expect(rows.every(r => r.status === 'complete')).toBe(true); expect(ports.grid).not.toHaveBeenCalled(); expect(ports.post).not.toHaveBeenCalled();
  });
  it('stops sample queue if actual camera settings fingerprint changes between samples', async () => {
    const { ports, context } = fixture(); context.mode = 'cameraMatch'; context.snapshot = { state: 'fabric', paused: false, profileVersion: 0, capabilities: { display: {} } };
    let fingerprint = 'one'; ports.fingerprint = () => fingerprint;
    const match = vi.fn(async () => { fingerprint = 'two'; return { status: 'complete' }; });
    await expect(runCameraMatchQueue({ ...ports, match })).rejects.toThrow(/تنظیمات/);
    expect(match).toHaveBeenCalledOnce(); expect(ports.capture).toHaveBeenCalledOnce();
  });
});
