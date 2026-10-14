import { describe, expect, it, vi } from 'vitest';
import { runNeutralGuide } from './neutralGuide';
import type { NeutralCards } from './neutralCards';
import { newRegion } from './regions';
const detection: NeutralCards = { status: 'ready', cards: (['dark', 'middle', 'light'] as const).map((role, order) => ({ role, region: { ...newRegion([[order * 30, 0], [order * 30 + 20, 0], [order * 30 + 20, 20], [order * 30, 20]], order + 1), id: role, selectionMethod: 'autoDetected', operatorConfirmed: false }, observedRgb: [0.3, 0.4, 0.5], confidence: 0.9 })), nextAction: 'ثابت', evidence: { referenceValues: 'unknown', physicalStandardVerified: false, method: 'boundedColorComponentsOrientedGeometry', candidateCount: 3, analysisWidth: 320, analysisHeight: 320, limitations: [] } };
describe('automatic user neutral card phase', () => {
  it('takes one co-captured batch for all actual detected regions without invented neutral values', async () => {
    const signal = new AbortController().signal;
    const scan = vi.fn(async () => detection), capture = vi.fn(async () => [[{ id: 'd' }], [{ id: 'm' }], [{ id: 'l' }]] as never);
    const post = vi.fn(async () => ({ status: 'limitedNeutralCheck', referenceValuesKnown: false, fullColorCalibration: false, cameraControlsApplied: false }));
    const report = await runNeutralGuide({ scan, capture, post, fingerprint: () => 'actual-settings', signal, overlay: vi.fn() });
    expect(scan).toHaveBeenCalledOnce(); expect(capture).toHaveBeenCalledWith(detection.cards.map(c => c.region), signal);
    expect(post).toHaveBeenCalledWith('neutral-check', { cards: [{ role: 'dark', frames: [{ id: 'd' }] }, { role: 'middle', frames: [{ id: 'm' }] }, { role: 'light', frames: [{ id: 'l' }] }], fingerprint: 'actual-settings' });
    expect(report.fullColorCalibration).toBe(false);
  });
  it('shows detector framing action instead of attempting capture or manual rectangle selection', async () => {
    const capture = vi.fn(), post = vi.fn();
    await expect(runNeutralGuide({ scan: async () => ({ ...detection, status: 'needsFraming', cards: [], nextAction: 'سه کارت را کامل داخل قاب بگذارید.' }), capture, post, signal: new AbortController().signal, overlay: vi.fn(), fingerprint: () => '' })).rejects.toThrow('سه کارت');
    expect(capture).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
  it('aborts during scan and never posts delayed evidence', async () => {
    const controller = new AbortController(), post = vi.fn(), capture = vi.fn();
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const run = runNeutralGuide({ scan: () => { entered(); return new Promise(() => {}); }, capture, post, signal: controller.signal, overlay: vi.fn(), fingerprint: () => '' });
    await started; controller.abort(); await expect(run).rejects.toThrow(/متوقف/); expect(capture).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
});
