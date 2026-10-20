import { describe, expect, it, vi } from 'vitest';
import * as sampling from './sampling';
import { execFileSync } from 'node:child_process';
import { pythonBin } from './testPaths';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { bounds, contains, type Point } from './sampling';
import { detectSwatchLayout } from './swatchDetection';

function texturedBands(width = 640, height = 480) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const band = Math.floor(y / (height / 8));
    const fold = Math.round(10 * Math.sin(x / 35)), noise = (x * 71 + y * 37) % 5 - 2;
    data.set([95 + band * 12 + fold + noise, 65 + band * 10 + fold + noise, 55 + band * 9 + fold + noise, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

describe('independent bounded swatch geometry', () => {
  it.each([[0, 0, 0], [2, 2, 2], [0, 110, 70]])('retains a bounded opaque %j band inside a four-piece colored stack', (r, g, b) => {
    const width = 320, height = 400, data = new Uint8ClampedArray(width * height * 4);
    const colors = [[130, 80, 60], [r, g, b], [60, 140, 90], [100, 80, 160]];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inside = x >= 80 && x < 240 && y >= 40 && y < 360;
      data.set([...(inside ? colors[Math.floor((y - 40) / 80)] : [190, 190, 190]), 255], (y * width + x) * 4);
    }
    const result = detectSwatchLayout({ width, height, data });
    expect(result.fabricRegions, JSON.stringify(result.evidence)).toHaveLength(4);
    expect(result.status).toBe('ready');
    result.fabricRegions.forEach((region, index) => {
      const rect = bounds(region.polygon);
      expect(rect.y).toBeGreaterThanOrEqual(40 + index * 80 - 3);
      expect(rect.y + rect.height).toBeLessThanOrEqual(40 + (index + 1) * 80);
      expect(region.geometryStatus).toBe('full');
      expect(region.operatorConfirmed).toBe(false);
      expect(region).not.toHaveProperty('acceptedMeasurement');
    });
    expect(contains([160, 160], result.fabricRegions[1].polygon)).toBe(true);
    expect(result.evidence.geometryOnly).toBe(true);
  });
  it.each([0, 3])('retains a physically closed black band at stack position %i without inferring beyond its edges', position => {
    const width = 320, height = 400, data = new Uint8ClampedArray(width * height * 4);
    const colors = [[130, 80, 60], [80, 130, 60], [60, 140, 90], [100, 80, 160]];
    colors[position] = [0, 0, 0];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inside = x >= 80 && x < 240 && y >= 40 && y < 360;
      data.set([...(inside ? colors[Math.floor((y - 40) / 80)] : [190, 190, 190]), 255], (y * width + x) * 4);
    }
    const result = detectSwatchLayout({ width, height, data });
    expect(result.fabricRegions).toHaveLength(4);
    expect(contains([160, 80 + position * 80], result.fabricRegions[position].polygon)).toBe(true);
    expect(result.evidence.limitations).toContain('Bounded dark-band geometry only; black fabric, clipped pixels and shadow remain indistinguishable. Preview only, not true-color evidence.');
  });
  it('preserves a black fabric region with thin bright lines and an excluded display footprint', () => {
    const width = 320, height = 400, data = new Uint8ClampedArray(width * height * 4);
    const colors = [[130, 80, 60], [0, 0, 0], [60, 140, 90], [100, 80, 160]];
    const exclusions: Point[][] = [[[110, 65], [140, 65], [140, 335], [110, 335]]];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inside = x >= 80 && x < 240 && y >= 40 && y < 360;
      let rgb = inside ? colors[Math.floor((y - 40) / 80)] : [190, 190, 190];
      if (inside && y % 80 === 0) rgb = [230, 230, 230];
      if (contains([x + 0.5, y + 0.5], exclusions[0])) rgb = x < 115 || x >= 135 ? [0, 0, 0] : [230, 160, 40];
      data.set([...rgb, 255], (y * width + x) * 4);
    }
    const result = detectSwatchLayout({ width, height, data }, exclusions);
    expect(result.fabricRegions).toHaveLength(4);
    result.fabricRegions.forEach(region => expect(region.exclusions).toEqual(exclusions));
    expect(contains([200, 160], result.fabricRegions[1].polygon)).toBe(true);
    expect(result.evidence.limitations.some(warning => warning.includes('Preview only'))).toBe(true);
  });
  it.each(['empty', 'background', 'bezel', 'thinShadow'])('does not infer black fabric from %s without repeated dark-band geometry', scene => {
    const width = 320, height = 400, data = new Uint8ClampedArray(width * height * 4);
    const colors = [[130, 80, 60], [80, 130, 60], [60, 140, 90], [100, 80, 160]];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inside = x >= 80 && x < 240 && y >= 40 && y < 360;
      let rgb = scene === 'empty' ? [0, 0, 0] : inside ? colors[Math.floor((y - 40) / 80)] : scene === 'background' ? [0, 0, 0] : [190, 190, 190];
      if (scene === 'bezel' && x >= 72 && x < 248 && y >= 32 && y < 368 && !inside) rgb = [0, 0, 0];
      if (scene === 'thinShadow' && inside && y >= 152 && y < 156) rgb = [0, 0, 0];
      data.set([...rgb, 255], (y * width + x) * 4);
    }
    const result = detectSwatchLayout({ width, height, data });
    if (scene === 'empty') {
      expect(result.fabricRegions).toEqual([]);
      expect(result.status).toBe('needsFraming');
    } else {
      expect(result.fabricRegions).toHaveLength(4);
      expect(result.fabricRegions.every(region => bounds(region.polygon).y >= 40 && bounds(region.polygon).y + bounds(region.polygon).height <= 360)).toBe(true);
      expect(result.evidence.limitations.some(warning => warning.includes('Preview only'))).toBe(false);
    }
  });
  it('keeps the actual screenshot 14 cyan fold as uncertain geometry rather than several material IDs', () => {
    const fixture = JSON.parse(readFileSync('src/fixtures/live-screenshot-14.json', 'utf8'));
    const data = new Uint8ClampedArray(execFileSync(pythonBin(), ['-c', 'from PIL import Image; import sys; sys.stdout.buffer.write(Image.open(sys.argv[1]).convert("RGBA").tobytes())', 'src/fixtures/live-screenshot-14.png'], { maxBuffer: 2_000_000 }));
    expect(createHash('sha256').update(data).digest('hex')).toBe(fixture.pixelSha256);
    expect(fixture.humanConfirmed).toBe(false);
    expect(fixture.physicalBandCount).toBeNull();
    const result = detectSwatchLayout({ width: 495, height: 495, data }, fixture.objectExclusions);
    // This is an upper bound on old false splits, not a asserted physical swatch count.
    expect(result.fabricRegions.length).toBeGreaterThanOrEqual(4);
    expect(result.fabricRegions.length).toBeLessThanOrEqual(7);
    expect(result.fabricRegions.filter(r => bounds(r.polygon).y > 155 && bounds(r.polygon).y < 245).length).toBeLessThanOrEqual(2);
    expect(result.status).toBe('ambiguous');
    expect(result.evidence.reason).toBe('foldOrPhysicalBoundary');
  });
  it('masks a localized unknown colored object without erasing the underlying full-width band', () => {
    const target = texturedBands();
    for (let y = 125; y < 280; y++) for (let x = 170; x < 340 + Math.floor((y - 125) / 4); x++) target.data.set([235, 35, 165, 255], (y * 640 + x) * 4);
    const result = detectSwatchLayout(target);
    expect(result.fabricRegions).toHaveLength(8);
    const region = result.fabricRegions[3];
    expect(region.exclusions.some(p => contains([240, 220], p))).toBe(true);
    expect(region.exclusions.length).toBeLessThanOrEqual(32);
    expect(region.exclusions.every(p => !contains([550, 220], p))).toBe(true);
  });
  it('removes paired full-width shadow folds inside one piece without merging close physical bands', () => {
    const target = texturedBands();
    for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) {
      const band = Math.floor(y / 60), local = y % 60;
      const shade = local >= 24 && local < 36 ? -35 : 0;
      target.data.set([95 + band * 12 + shade, 65 + band * 10 + shade, 55 + band * 9 + shade, 255], (y * 640 + x) * 4);
    }
    const result = detectSwatchLayout(target);
    expect(result.fabricRegions).toHaveLength(8);
    result.fabricRegions.forEach((region, index) => {
      const rect = bounds(region.polygon);
      expect(rect.y).toBeGreaterThanOrEqual(index * 60);
      expect(rect.y + rect.height).toBeLessThanOrEqual((index + 1) * 60);
    });
  });
  it('reuses bounded median scratch buffers without sorting a new array for every filtered pixel', () => {
    const target = texturedBands();
    const baseline = detectSwatchLayout(target);
    const sorts = vi.spyOn(Array.prototype, 'sort');
    let result: ReturnType<typeof detectSwatchLayout>, calls: number;
    try { result = detectSwatchLayout(target); calls = sorts.mock.calls.length; }
    finally { sorts.mockRestore(); }
    expect(result!).toEqual(baseline);
    expect(calls!).toBeLessThan(1000);
  });
  it('tests exclusion containment only within each polygon bounding box and preserves its mask', () => {
    const target = texturedBands();
    const polygons: Point[][] = [[[300, 210], [324, 210], [324, 234], [300, 234]], [[302, 213], [322, 215], [318, 232], [305, 230]]];
    const baseline = detectSwatchLayout(target, polygons);
    const containment = vi.spyOn(sampling, 'contains');
    let result: ReturnType<typeof detectSwatchLayout>, calls: number;
    try { result = detectSwatchLayout(target, polygons); calls = containment.mock.calls.length; }
    finally { containment.mockRestore(); }
    expect(result!).toEqual(baseline);
    expect(result!.fabricRegions.every(r => r.exclusions !== polygons && r.exclusions[0] !== polygons[0])).toBe(true);
    expect(calls!).toBeLessThan(1200);
  });
  it('bounds a 2160 square analysis to 640 and never extends clipped geometry beyond the source', () => {
    const target = texturedBands(2160, 2160);
    const result = detectSwatchLayout(target);
    expect(result.evidence.analysisWidth).toBe(640);
    expect(result.evidence.analysisHeight).toBe(640);
    expect(result.fabricRegions).toHaveLength(8);
    expect(result.fabricRegions.every(r => r.clipped && r.geometryStatus === 'candidate')).toBe(true);
    result.fabricRegions.forEach(r => r.polygon.forEach(p => expect(p.every(v => v >= 0 && v <= 2160)).toBe(true)));
  });
  it('rejects malformed frames and invalid exclusion polygons without manufactured masks', () => {
    const image = texturedBands();
    const invalid = [{ ...image, width: -1 }, { ...image, data: new Uint8ClampedArray(0) }, { ...image, data: new Float32Array(image.data.length).fill(NaN) }];
    invalid.forEach(frame => expect(detectSwatchLayout(frame).fabricRegions).toEqual([]));
    expect(detectSwatchLayout(image, [[[NaN, 0], [20, 0], [20, 20]]]).fabricRegions).toEqual([]);
  });
  it('does not turn a flat frame, two clipped bands or localized card borders into a fabric stack', () => {
    for (const count of [1, 2]) {
      const target = texturedBands();
      for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) target.data.set([120 + Math.floor(y / (480 / count)) * 40, 90, 65, 255], (y * 640 + x) * 4);
      expect(detectSwatchLayout(target).fabricRegions).toEqual([]);
    }
    const target = texturedBands();
    for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) {
      const card = x > 220 && x < 400 && y > 80 && y < 380;
      target.data.set(card ? [30 + Math.floor((y - 80) / 100) * 90, 30 + Math.floor((y - 80) / 100) * 90, 30 + Math.floor((y - 80) / 100) * 90, 255] : [110, 90, 75, 255], (y * 640 + x) * 4);
    }
    expect(detectSwatchLayout(target).fabricRegions).toEqual([]);
  });
  it('does not split smooth horizontal fold shading into invented color bands', () => {
    const target = texturedBands();
    for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) {
      const shade = Math.round(12 * Math.sin(y / 12));
      target.data.set([140 + shade, 110 + shade, 90 + shade, 255], (y * 640 + x) * 4);
    }
    expect(detectSwatchLayout(target).fabricRegions).toEqual([]);
  });
  it('proposes ordered geometry from the unchanged actual P3 swatch photo without physical color truth', () => {
    const source = '../references/02-swatch-bands.jpg';
    expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe('ae19fc687b927e4af8362add615a6667a14ff5106a628189937811318b92c2e2');
    // Pillow decodes original encoded pixels for geometry only; no calibrated color assertions.
    const data = new Uint8ClampedArray(execFileSync(pythonBin(), ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert("RGBA"); im=im.resize((216,384)); sys.stdout.buffer.write(im.tobytes())', source]));
    const result = detectSwatchLayout({ width: 216, height: 384, data }, [[[0, 0], [44, 0], [44, 384], [0, 384]]]);
    // Intentional boundary-vote and local-mask changes supersede the old output hash.
    // Keep source bytes frozen and require deterministic, ordered, bounded geometry instead.
    expect(detectSwatchLayout({ width: 216, height: 384, data }, [[[0, 0], [44, 0], [44, 384], [0, 384]]])).toEqual(result);
    expect(result.fabricRegions.length).toBeGreaterThanOrEqual(8);
    expect(result.fabricRegions.length).toBeLessThanOrEqual(14);
    expect(result.fabricRegions.every(region => !region.operatorConfirmed && region.selectionMethod === 'autoDetected')).toBe(true);
    expect(result.fabricRegions.map(r => bounds(r.polygon).y)).toEqual(result.fabricRegions.map(r => bounds(r.polygon).y).sort((a, b) => a - b));
  });
  it('keeps repeated textured bands across a fold and polygon occlusions without counting card edges', () => {
    const target = texturedBands();
    const exclusions: Point[][] = [
      [[20, 40], [185, 40], [185, 290], [20, 290]],
      [[270, 65], [390, 65], [390, 145], [270, 145]],
      [[450, 100], [570, 100], [570, 180], [450, 180]],
      [[360, 300], [470, 340], [445, 410], [335, 370]],
    ];
    for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) if (exclusions.some(p => contains([x + 0.5, y + 0.5], p))) target.data.set([140, 140, 140, 255], (y * 640 + x) * 4);
    const result = detectSwatchLayout(target, exclusions);
    expect(result.fabricRegions).toHaveLength(8);
    result.fabricRegions.forEach((region, index) => {
      const rect = bounds(region.polygon);
      expect(rect.y).toBeGreaterThanOrEqual(index * 60);
      expect(rect.y + rect.height).toBeLessThanOrEqual((index + 1) * 60);
      expect(region.exclusions).toEqual(exclusions);
      expect(region.geometryStatus).toBe('candidate');
      expect(region.clipped).toBe(true);
      expect(region).not.toHaveProperty('acceptedMeasurement');
    });
  });
});
