import { describe, expect, it } from 'vitest';
import { sceneRegions, guidedSceneAction, suppliedReferenceRegions } from './automaticScene';
import type { Reference } from './workflow';
import type { LiveScene } from './liveScene';
const roi = { id: 'auto', label: 'auto', order: 1, mode: 'solid' as const, polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][], exclusions: [], background: null, layers: null, direction: null, operatorConfirmed: false, source: 'autoDetected' as const, confidence: 0.9 };
const scene: LiveScene = { status: 'ready', displayRegion: { ...roi, id: 'screen' }, marker: { x: 20, y: 20, width: 112, height: 4 }, fabricRegions: [{ ...roi, id: 'fabric' }], neutralCandidates: [], nextAction: 'قاب را ثابت نگه دارید.', evidence: { markerSequence: 3, markerCandidates: 1, referenceIdentity: 'unknown', method: 'boundedRasterGeometry', limitations: [] } };
describe('guided machine scene boundary', () => {
  it('keeps machine provenance false and strips unsupported vision fields before REST', () => {
    const rows = sceneRegions(scene);
    expect(rows).toHaveLength(2);
    for (const row of rows) { expect(row.selectionMethod).toBe('autoDetected'); expect(row.operatorConfirmed).toBe(false); expect(row).not.toHaveProperty('confidence'); expect(row).not.toHaveProperty('source'); }
  });
  it('keeps unknown physical card identity explicit, never silently switches calibrated mode', () => {
    expect(guidedSceneAction(scene, 'threeStage', false)).toMatch(/مرجع/);
    expect(guidedSceneAction(scene, 'cameraMatch', false)).toMatch(/ثابت/);
    expect(guidedSceneAction({ ...scene, status: 'ambiguous', nextAction: 'قاب را مستقیم کنید.' }, 'cameraMatch', false)).toBe('قاب را مستقیم کنید.');
  });
  it('binds only explicitly supplied display-relative physical patch identity and independent geometry', () => {
    const reference: Reference = { id: 'real', label: 'card', source: 'measured', version: '1', valueType: 'Lab', referenceWhite: 'D50', observer: '2', validity: 'verified', xyzScale: 1, health: null, patches: [{ id: 'known', values: [50, 0, 0], split: 'train', neutral: true }], geometry: { coordinateSystem: 'displayRelative', cardPatchId: 'known', patches: [{ patchId: 'known', polygon: [[2, 0], [3, 0], [3, 1], [2, 1]] }], witnessPolygon: [[4, 0], [5, 0], [5, 1], [4, 1]] } };
    const physicalScene = { ...scene, fabricRegions: [] };
    expect(suppliedReferenceRegions(reference, physicalScene, 100, 100)).toMatchObject({ bindings: { known: 'auto-reference-known' }, cardPatchId: 'known' });
    expect(suppliedReferenceRegions({ ...reference, geometry: null }, physicalScene, 100, 100)).toBeNull();
    expect(() => suppliedReferenceRegions({ ...reference, geometry: { ...reference.geometry, patches: [{ patchId: 'invented', polygon: [[2, 0], [3, 0], [3, 1]] }] } }, physicalScene, 100, 100)).toThrow(/شناسه/);
    expect(() => suppliedReferenceRegions(reference, physicalScene, 20, 20)).toThrow(/خارج/);
  });
});
