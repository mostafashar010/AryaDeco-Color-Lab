import { describe, expect, it, vi } from 'vitest';
import { parseReference, normalizedRegion, waitForPatch, runGrid, runMatch, runCameraMatch, DISPLAY_GRID, referenceCaptureKey, groupCapacity, measurementPayload } from './workflow';
import { newRegion } from './regions';

describe('referenced inputs and coordinate contract', () => {
  it('imports actual JSON or CSV patches without inventing verified data', () => {
    const metadata = { id: 'card', label: 'کارت', source: 'instrument', version: '1', valueType: 'Lab' as const, referenceWhite: 'D50' as const, observer: '2' as const, validity: 'unverified' as const };
    const target = parseReference('id,v1,v2,v3,split,neutral\na,50,0,0,train,true\nb,30,4,2,holdout,false', metadata);
    expect(target).toMatchObject({ ...metadata, xyzScale: 1, geometry: null, health: null });
    expect(target.patches[1]).toEqual({ id: 'b', values: [30, 4, 2], split: 'holdout', neutral: false });
    expect(parseReference(JSON.stringify(target), metadata)).toEqual(target);
    expect(() => parseReference('id,v1,v2,v3,split,neutral\na,NaN,0,0,train,true', metadata)).toThrow();
    expect(() => parseReference('id,v1,v2,v3,split,neutral\na,,0,0,train,true', metadata)).toThrow();
    expect(() => parseReference('wrong,header\na,50,0,0,train,true', metadata)).toThrow();
  });
  it('normalizes original image coordinates only at API boundary', () => {
    const r = newRegion([[10, 20], [100, 20], [100, 80], [10, 80]], 1);
    expect(normalizedRegion(r, 200, 100).polygon).toEqual([[0.05, 0.2], [0.5, 0.2], [0.5, 0.8], [0.05, 0.8]]);
    expect(r.polygon[0]).toEqual([10, 20]);
  });
  it('changes captured reference lineage when ROI or binding edits and fits group within viewport', () => {
    const r = newRegion([[10, 20], [100, 20], [100, 80], [10, 80]], 1);
    expect(referenceCaptureKey([r], { a: r.id })).not.toBe(referenceCaptureKey([{ ...r, polygon: [[20, 20], [100, 20], [100, 80], [20, 80]] }], { a: r.id }));
    expect(referenceCaptureKey([r], { a: r.id })).not.toBe(referenceCaptureKey([r], { b: r.id }));
    expect(groupCapacity(390, 720)).toBe(2); expect(groupCapacity(1200, 800)).toBeGreaterThanOrEqual(4);
  });
  it('binds fabric measurement to same-callback card and neutral evidence rather than just sample pixels', () => {
    const r = newRegion([[0, 0], [50, 0], [50, 50], [0, 50]], 1);
    const frames = [{ id: 'f', colorSpace: 'srgb' }], witness = [{ id: 'w' }], card = [{ id: 'c' }];
    expect(measurementPayload(r, 100, 100, frames as never, witness as never, card as never, 'neutral')).toMatchObject({ frames, witnessFrames: witness, cardFrames: card, cardPatchId: 'neutral', sourceCaptureIds: ['f'], sourceColorSpace: 'srgb' });
  });
});
describe('autonomous loop waits fresh server command, render ACK and physical captures', () => {
  it('does not accept stale patch or mere command without rendered flag', async () => {
    let patch = { patchId: 'stale', commandSequence: 1, displayDriveRgb: [0, 0, 0] as [number, number, number], profileVersion: 1, layout: 'single' as const, sampleIds: [], rendered: true };
    const p = waitForPatch(() => patch, 'fresh', 2, new AbortController().signal);
    setTimeout(() => { patch = { ...patch, patchId: 'fresh', commandSequence: 2, rendered: true }; }, 30);
    expect((await p).commandSequence).toBe(2);
  });
  it('grid gathers baseline/checks and held-out physical frames before server fit', async () => {
    const request = vi.fn().mockImplementation(async (_drive, id) => ({ patchId: id, commandSequence: request.mock.calls.length })); const capture = vi.fn().mockResolvedValue([['patch'], ['witness'], ['card'], ['fabric']]); const post = vi.fn().mockResolvedValue({ status: 'CameraReferencedDisplayCompensationProfile' });
    await runGrid({ request, capture, post, fingerprint: 'f', signal: new AbortController().signal, progress: vi.fn() });
    expect(request).toHaveBeenCalledTimes(DISPLAY_GRID.length + 3);
    const payload = post.mock.calls[0][1];
    expect(payload.observations.filter((o: { split: string }) => o.split === 'holdout')).toHaveLength(3);
    expect(payload.contaminationChecks).toHaveLength(2);
    expect(payload.contaminationBaseline).toEqual(['witness']);
    expect(payload.contaminationFabricBaseline).toEqual(['fabric']);
    expect(payload.contaminationFabricChecks).toHaveLength(2);
    expect(payload.observations.every((o: { frames: unknown[]; witnessFrames: unknown[] }) => o.frames.length && o.witnessFrames.length)).toBe(true);
  });
  it('match uses server nextDrive and bound, not local invented optimized RGB', async () => {
    const request = vi.fn().mockResolvedValue({ patchId: 'p', commandSequence: 4 });
    const capture = vi.fn().mockResolvedValue([['p-frame'], ['w-frame'], ['c-frame'], ['fabric-frame']]);
    const post = vi.fn().mockResolvedValueOnce({ runId: 'run', nextDrive: [0.2, 0.3, 0.4], status: 'running', patchId: 'p', commandSequence: 4 }).mockResolvedValueOnce({ runId: 'run', nextDrive: null, status: 'complete', terminationReason: 'tolerance', bestDrive: [0.2, 0.3, 0.4] });
    const result = await runMatch('m', { request, capture, post, signal: new AbortController().signal, progress: vi.fn(), cardPatchId: 'neutral' });
    expect(post.mock.calls[0]).toEqual(['matches', { measurementId: 'm', maxEvaluations: 40, target: 0.01, noiseFloor: 0.002 }]);
    expect(post.mock.calls[1][1]).toMatchObject({ markerSequence: 4, commandSequence: 4, patchId: 'p', witnessFrames: ['w-frame'], layout: 'single' });
    expect(post.mock.calls[1][1]).toMatchObject({ cardFrames: ['c-frame'], fabricFrames: ['fabric-frame'], cardPatchId: 'neutral' });
    expect(result.terminationReason).toBe('tolerance');
  });
  it('explicit camera match never calls calibrated routes and binds screen plus frozen fabric only', async () => {
    const region = newRegion([[0, 0], [50, 0], [50, 50], [0, 50]], 1);
    const post = vi.fn().mockResolvedValueOnce({ runId: 'run', measurementId: 'm', nextDrive: [0.2, 0.3, 0.4], patchId: 'p', commandSequence: 3 }).mockResolvedValueOnce({ runId: 'run', nextDrive: null, status: 'complete' });
    const result = await runCameraMatch(region, 100, 100, { request: vi.fn(async () => ({ patchId: 'p', commandSequence: 3 })), capture: vi.fn(async () => [['screen'], ['fabric']] as never), post, targetFrames: [{ id: 'target', colorSpace: 'srgb' }] as never, signal: new AbortController().signal, progress: vi.fn() });
    expect(post.mock.calls[0][0]).toBe('camera-matches'); expect(post.mock.calls[0][1]).toMatchObject({ maxEvaluations: 40, frames: [{ id: 'target', colorSpace: 'srgb' }] });
    expect(post.mock.calls[1]).toEqual(['camera-matches/run/observe', { frames: ['screen'], fabricFrames: ['fabric'], markerSequence: 3, commandSequence: 3, patchId: 'p', stable: true, layout: 'single' }]);
    expect(result.measurementId).toBe('m');
  });
  it('renders server bestDrive at termination with fresh ACK without another quality evaluation', async () => {
    const region = newRegion([[0, 0], [50, 0], [50, 50], [0, 50]], 1);
    const request = vi.fn(async (_drive: number[], _id: string, _sequence?: number) => ({ patchId: 'p', commandSequence: 3 }));
    const post = vi.fn().mockResolvedValueOnce({ runId: 'run', nextDrive: [0.2, 0.3, 0.4], patchId: 'p', commandSequence: 3 }).mockResolvedValueOnce({ nextDrive: null, status: 'stopped', bestDrive: [0.1, 0.2, 0.3] });
    const result = await runCameraMatch(region, 100, 100, { request, capture: vi.fn(async () => [[], []]), post, targetFrames: [{ id: 'target', colorSpace: 'srgb' }] as never, signal: new AbortController().signal, progress: vi.fn() });
    expect(request).toHaveBeenCalledTimes(2); expect(request.mock.calls[1][0]).toEqual([0.1, 0.2, 0.3]);
    expect(result).toMatchObject({ status: 'stopped', terminalDisplay: 'renderedBestDriveOnly' }); expect(post).toHaveBeenCalledTimes(2);
  });
});
