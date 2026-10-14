import { describe, it, expect } from 'vitest';
import type { Region } from './sampling';
import { suggestLiveBands, suggestLiveRegions } from './liveBands';

const region: Region = { id: 'cloth', label: 'پارچه', order: 0, mode: 'bands', polygon: [[0, 0], [120, 0], [120, 120], [0, 120]], exclusions: [], background: 'white', layers: 1, direction: 'horizontal', operatorConfirmed: true };
function image(colors: number[][]) {
  const data = new Uint8ClampedArray(120 * 120 * 4);
  for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) {
    const i = (y * 120 + x) * 4;
    data.set([...colors[Math.min(colors.length - 1, Math.floor(y / (120 / colors.length)))], 255], i);
  }
  return { data, width: 120, height: 120 };
}
describe('bounded live-frame geometry proposals, never color measurements', () => {
  it('proposes ordered separate near-color strips requiring operator confirmation', () => {
    const result = suggestLiveBands(image([[130, 80, 60], [136, 86, 66], [70, 80, 120]]), region);
    expect(result.regions).toHaveLength(3);
    expect(result.regions.every(r => !r.operatorConfirmed)).toBe(true);
    expect(result.regions.map(r => r.order)).toEqual([0, 1, 2]);
    expect(result.regions[0].background).toBe('white');
    expect(result.regions[1].polygon[0][1]).toBeGreaterThan(35);
    expect(result.method).toBe('singleFrameGeometryProposalNotMeasurement');
  });
  it('does not invent bands in a flat single-color area', () => {
    const result = suggestLiveBands(image([[120, 100, 80]]), region);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].operatorConfirmed).toBe(false);
  });
  it('preserves source offsets and existing masks without marking synthetic geometry valid', () => {
    const shifted = { ...region, polygon: region.polygon.map(([x,y]) => [x + 20, y + 10] as [number, number]), exclusions: [[[20, 10], [30, 10], [30, 130], [20, 130]] as [number, number][]] };
    const result = suggestLiveBands(image([[120, 100, 80], [60, 80, 100]]), shifted, { x: 20, y: 10 });
    expect(result.regions).toHaveLength(2);
    expect(result.regions[0].polygon[0][0]).toBeGreaterThanOrEqual(20);
    expect(result.regions[0].exclusions).toEqual(shifted.exclusions);
  });
  it('rejects oversized or empty source data rather than unbounded camera processing', () => {
    expect(() => suggestLiveBands({ data: new Uint8ClampedArray(), width: 10000, height: 10000 }, region)).toThrow();
  });
  it('does not expand triangular fabric selections onto the background', () => {
    const triangle = { ...region, polygon: [[0,0],[120,0],[0,120]] as [number, number][] };
    const result = suggestLiveBands(image([[120,100,80],[60,80,100]]), triangle);
    expect(result.regions).toHaveLength(2);
    expect(result.regions.every(r => r.polygon.every(([x,y]) => x+y <= 120.001))).toBe(true);
  });
  it('refuses video suggestions before real native frames are available', async () => {
    await expect(suggestLiveRegions(document.createElement('video'), region)).rejects.toThrow();
  });
  it('rejects transparent and non-finite pixels instead of selecting invisible fabric', () => {
    expect(() => suggestLiveBands({ width: 120, height: 120, data: new Uint8ClampedArray(120*120*4) },region)).toThrow();
    expect(() => suggestLiveBands({ width: 120, height: 120, data: new Float32Array(120*120*4).fill(NaN) },region)).toThrow();
  });
  it('does not split smooth fold shading into invented fabric colors', () => {
    const target = image([[120,100,80]]);
    for (let y=0;y<120;y++) for (let x=0;x<120;x++) {
      const shade = Math.round(12*Math.sin(y/120*Math.PI*6));
      target.data.set([120+shade,100+shade,80+shade,255],(y*120+x)*4);
    }
    expect(suggestLiveBands(target,region).regions).toHaveLength(1);
  });
});
