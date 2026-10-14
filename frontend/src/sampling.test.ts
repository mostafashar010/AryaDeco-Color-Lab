import { describe, expect, it } from 'vitest';
import { sampleRegion, bounds, contains } from './sampling';

describe('lossless original-coordinate ROI block sampling', () => {
  const region = { id: 'r', label: 'پارچه', order: 1, mode: 'solid' as const, polygon: [[0, 0], [32, 0], [32, 32], [0, 32]] as [number, number][], exclusions: [[[0, 0], [8, 0], [8, 32], [0, 32]]] as [number, number][][], background: null, layers: null, direction: null, operatorConfirmed: false };
  it('preserves encoded original samples and masks rather than averaging colors or JPEG', () => {
    const data = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([10, 128, 240, 255], i);
    const result = sampleRegion({ data, width: 32, height: 32 }, { x: 0, y: 0 }, region);
    expect(result.pixelCount).toBe(1024); expect(result.excludedCount).toBe(256);
    expect(result.pixels[0]).toEqual([10 / 255, 128 / 255, 240 / 255]);
    expect(new Set(result.blockIds).size).toBeGreaterThan(4);
    expect(result.blockIds).toHaveLength(result.pixels.length);
  });
  it('caps payload samples while keeping full selected/excluded counts and unique source bytes', () => {
    const data = new Float32Array(256 * 256 * 4).fill(0.3);
    const r = { ...region, polygon: [[10, 20], [266, 20], [266, 276], [10, 276]] as [number, number][], exclusions: [] };
    const result = sampleRegion({ data, width: 256, height: 256 }, { x: 10, y: 20 }, r);
    expect(result.pixels.length).toBeLessThanOrEqual(8192); expect(result.pixelCount).toBe(65536);
    expect(result.pixels.length).toBeLessThanOrEqual(512);
    expect(result.pixels[0][0]).toBe(data[0]);
    expect(bounds(r.polygon)).toEqual({ x: 10, y: 20, width: 256, height: 256 });
    expect(contains([15, 25], r.polygon)).toBe(true);
  });
  it('rejects nonfinite or out-of-range floating pixels instead of clipping or claiming raw', () => {
    const data = new Float32Array(32 * 32 * 4).fill(1.2);
    expect(() => sampleRegion({ data, width: 32, height: 32 }, { x: 0, y: 0 }, region)).toThrow();
  });
});
