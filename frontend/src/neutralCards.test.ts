import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { detectNeutralCards } from './neutralCards';
import { contains } from './sampling';

const fixture = JSON.parse(readFileSync('src/fixtures/neutral-cards-real.json', 'utf8'));
const photo = () => ({ width: fixture.width as number, height: fixture.height as number, data: new Uint8ClampedArray(Buffer.from(fixture.rgbaBase64, 'base64')) });
const draft = [
  [[417, 30], [803, 226], [694, 461], [313, 270]],
  [[354, 489], [775, 482], [779, 740], [361, 756]],
  [[387, 858], [798, 856], [795, 1104], [386, 1117]],
].map(p => p.map(([x, y]) => [x / 4, y / 4] as [number, number]));

function rotate(image: ReturnType<typeof photo>) {
  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const target = (x * image.height + image.height - y - 1) * 4;
    data.set(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4), target);
  }
  return { width: image.height, height: image.width, data };
}

function scene(cards: number[][]) {
  const width = 360, height = 360, data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([174, 159, 135, 255], i);
  cards.forEach((color, index) => {
    const left = index < 3 ? 35 : 215, top = 20 + index % 3 * 112;
    for (let y = top; y < top + 75; y++) for (let x = left; x < left + 120; x++) {
      const hole = Math.hypot(x - left - 110, y - top - 9) < 4;
      if (!hole) data.set([...color, 255], (y * width + x) * 4);
    }
  });
  return { width, height, data };
}

function framedPhoto(source = photo(), size = 480, left = 0, top = 0) {
  const width = 640, height = 480, data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([83, 72, 61, 255], i);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = Math.max(0, Math.min(source.width - 1, (x + 0.5) * source.width / size - 0.5));
    const py = Math.max(0, Math.min(source.height - 1, (y + 0.5) * source.height / size - 0.5));
    const x0 = Math.floor(px), y0 = Math.floor(py), dx = px - x0, dy = py - y0;
    for (let c = 0; c < 4; c++) {
      const p = (xx: number, yy: number) => source.data[(Math.min(source.height - 1, yy) * source.width + Math.min(source.width - 1, xx)) * 4 + c];
      data[((y + top) * width + x + left) * 4 + c] = (p(x0, y0) * (1 - dx) + p(x0 + 1, y0) * dx) * (1 - dy) + (p(x0, y0 + 1) * (1 - dx) + p(x0 + 1, y0 + 1) * dx) * dy;
    }
  }
  return { width, height, data };
}

describe('automatic geometry of supplied neutral cards', () => {
  it('preserves the complete pre-optimization real-photo result including numeric geometry and evidence', () => {
    const result = detectNeutralCards(photo());
    expect(createHash('sha256').update(JSON.stringify(result)).digest('hex')).toBe('652ab7053f5b569c462bdc798fd569a4f9426f8715ce5efbed7974c4d8d881cd');
  });
  it('does not allocate mapped RGB arrays per analysis pixel or color comparison', () => {
    const target = framedPhoto();
    const maps = vi.spyOn(Array.prototype, 'map');
    let result: ReturnType<typeof detectNeutralCards>, calls: number;
    try { result = detectNeutralCards(target); calls = maps.mock.calls.length; }
    finally { maps.mockRestore(); }
    expect(result!.status).toBe('ready');
    expect(calls!).toBeLessThan(1000);
  });
  it('reports partial candidates and rejection counts instead of a silent generic failure',()=>{
    const result=detectNeutralCards(scene([[25,25,25],[130,130,130]]));
    expect(result.status).not.toBe('ready');
    expect(result.evidence.candidateCount).toBeGreaterThanOrEqual(2);
    expect(result.evidence.rejections).toBeDefined();
    expect(result.nextAction).toContain('۲');
    expect(result.evidence.candidateGeometry!.length).toBeGreaterThanOrEqual(2);
    expect(result.cards).toHaveLength(0);
  });
  it('detects interpolated actual photo inside a landscape camera frame with a right margin', () => {
    const image = framedPhoto();
    const result = detectNeutralCards(image);
    expect(result.status).toBe('ready');
    expect(result.cards.map(c => c.role)).toEqual(['dark', 'middle', 'light']);
    result.cards.forEach((card, i) => card.region.polygon.forEach(([x, y]) => expect(contains([x / 1.5, y / 1.5], draft[i])).toBe(true)));
    expect(result.cards[1].observedRgb[2] - result.cards[1].observedRgb[0]).toBeGreaterThan(0.04);
    expect(result.evidence.referenceValues).toBe('unknown');
    expect(result.evidence.physicalStandardVerified).toBe(false);
  });

  it.each([[480, 160, 0], [420, 65, 25], [360, 130, 60]])('keeps real-card geometry after interpolated scale %i with offset %i,%i', (size, left, top) => {
    const image = framedPhoto(photo(), size, left, top);
    const result = detectNeutralCards(image);
    expect(result.status).toBe('ready');
    result.cards.forEach((card, i) => {
      card.region.polygon.forEach(([x, y]) => expect(contains([(x - left) * 320 / size, (y - top) * 320 / size], draft[i])).toBe(true));
      const mean = [0, 0, 0]; let count = 0;
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (contains([x + 0.5, y + 0.5], card.region.polygon)) {
        expect(contains([(x + 0.5 - left) * 320 / size, (y + 0.5 - top) * 320 / size], draft[i])).toBe(true);
        for (let c = 0; c < 3; c++) mean[c] += image.data[(y * image.width + x) * 4 + c] / 255;
        count++;
      }
      mean.forEach((v, c) => expect(card.observedRgb[c]).toBeCloseTo(v / count, 5));
    });
  });

  it('detects interpolated quarter-turned real cards in a landscape frame', () => {
    const result = detectNeutralCards(framedPhoto(rotate(photo())));
    expect(result.status).toBe('ready');
    result.cards.forEach((card, i) => card.region.polygon.forEach(([x, y]) => expect(contains([y / 1.5, 320 - x / 1.5], draft[i])).toBe(true)));
  });

  it('finds three conservative interiors on the unchanged real photograph, preserving its blue cast', () => {
    const original = readFileSync('../references/03-user-neutral-cards.jpg');
    expect(createHash('sha256').update(original).digest('hex')).toBe(fixture.originalSha256);
    const image = photo();
    const result = detectNeutralCards(image);
    expect(result.status).toBe('ready');
    expect(result.cards.map(card => card.role)).toEqual(['dark', 'middle', 'light']);
    expect(result.evidence.referenceValues).toBe('unknown');
    expect(result.evidence.physicalStandardVerified).toBe(false);
    result.cards.forEach((card, index) => {
      expect(card.region.operatorConfirmed).toBe(false);
      expect(card.region.selectionMethod).toBe('autoDetected');
      expect(card.region.polygon).toHaveLength(4);
      card.region.polygon.forEach(point => expect(contains(point, draft[index])).toBe(true));
      const mean = [0, 0, 0]; let count = 0;
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (contains([x + 0.5, y + 0.5], card.region.polygon)) {
        expect(contains([x + 0.5, y + 0.5], draft[index])).toBe(true);
        for (let c = 0; c < 3; c++) mean[c] += image.data[(y * image.width + x) * 4 + c] / 255;
        count++;
      }
      expect(count).toBeGreaterThan(1200);
      mean.forEach((value, c) => expect(card.observedRgb[c]).toBeCloseTo(value / count, 5));
    });
    expect(result.cards[1].observedRgb[2] - result.cards[1].observedRgb[0]).toBeGreaterThan(0.04);
    expect(result.cards[2].observedRgb[2] - result.cards[2].observedRgb[0]).toBeGreaterThan(0.04);
    const tilted = result.cards[0].region.polygon;
    expect(Math.abs(tilted[0][1] - tilted[1][1])).toBeGreaterThan(10);
    [[334, 267], [756, 500], [780, 872]].forEach(([x, y], i) => expect(contains([x / 4, y / 4], result.cards[i].region.polygon)).toBe(false));
  });

  it('finds the same actual photograph after a quarter turn without axis-aligned assumptions', () => {
    const result = detectNeutralCards(rotate(photo()));
    expect(result.status).toBe('ready');
    result.cards.forEach((card, index) => card.region.polygon.forEach(([x, y]) => expect(contains([y, 320 - x], draft[index])).toBe(true)));
  });

  it('does not promote an empty frame or an incomplete pair to three cards', () => {
    expect(detectNeutralCards(scene([])).status).toBe('needsFraming');
    expect(detectNeutralCards(scene([[38, 45, 53], [108, 120, 136]])).status).toBe('needsFraming');
    expect(detectNeutralCards({ ...photo(), data: new Uint8ClampedArray(16) }).status).toBe('needsFraming');
  });

  it('rejects chromatically inconsistent colored rectangles rather than assuming they are neutral', () => {
    const result = detectNeutralCards(scene([[35, 45, 52], [80, 170, 65], [225, 225, 245]]));
    expect(result.status).not.toBe('ready');
    expect(result.cards).toEqual([]);
  });

  it('fails closed if several plausible triplets exist', () => {
    const result = detectNeutralCards(scene([[35, 43, 51], [110, 121, 135], [222, 226, 241], [36, 44, 52], [112, 122, 137], [220, 225, 239]]));
    expect(result.status).toBe('ambiguous');
    expect(result.cards).toEqual([]);
  });

  it('excludes corner holes without excluding or changing the original blue card pixels', () => {
    const image = scene([[35, 43, 51], [110, 121, 135], [222, 226, 241]]);
    const result = detectNeutralCards(image);
    expect(result.status).toBe('ready');
    result.cards.forEach((card, i) => {
      expect(contains([145, 29 + 112 * i], card.region.polygon)).toBe(false);
      card.observedRgb.forEach((value, c) => expect(value).toBeCloseTo([[35, 43, 51], [110, 121, 135], [222, 226, 241]][i][c] / 255, 6));
    });
  });

  it('bounds analysis at 640 pixels while returning geometry in native image coordinates', () => {
    const original = photo(), width = original.width * 4, height = original.height * 4;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const source = (Math.floor(y / 4) * original.width + Math.floor(x / 4)) * 4;
      data.set(original.data.subarray(source, source + 4), (y * width + x) * 4);
    }
    const result = detectNeutralCards({ width, height, data });
    expect(result.status).toBe('ready');
    expect(result.evidence.analysisWidth).toBeLessThanOrEqual(640);
    expect(result.evidence.analysisHeight).toBeLessThanOrEqual(640);
    result.cards.forEach((card, i) => card.region.polygon.forEach(([x, y]) => expect(contains([x / 4, y / 4], draft[i])).toBe(true)));
  });

  it('refuses cards with an interior obstruction rather than sampling background as card color', () => {
    const image = scene([[35, 43, 51], [110, 121, 135], [222, 226, 241]]);
    for (let y = 45; y < 70; y++) for (let x = 80; x < 105; x++) image.data.set([174, 159, 135, 255], (y * image.width + x) * 4);
    expect(detectNeutralCards(image).status).not.toBe('ready');
  });

  it('does not accept cards clipped by the image boundary', () => {
    const image = scene([[35, 43, 51], [110, 121, 135], [222, 226, 241]]);
    const width = 115, data = new Uint8ClampedArray(width * image.height * 4);
    for (let y = 0; y < image.height; y++) data.set(image.data.subarray(y * image.width * 4, (y * image.width + width) * 4), y * width * 4);
    expect(detectNeutralCards({ width, height: image.height, data }).status).not.toBe('ready');
  });

  it('accepts normalized float pixels without guessing byte encoding or altering cast', () => {
    const image = photo();
    const data = Float32Array.from(image.data, value => value / 255);
    const float = detectNeutralCards({ ...image, data });
    const bytes = detectNeutralCards(image);
    expect(float.status).toBe('ready');
    float.cards.forEach((card, i) => card.observedRgb.forEach((v, c) => expect(v).toBeCloseTo(bytes.cards[i].observedRgb[c], 5)));
  });

  it('fails closed on unsupported transparent or nonfinite float pixels', () => {
    const image = photo();
    image.data[(150 * image.width + 150) * 4 + 3] = 0;
    expect(detectNeutralCards(image).status).toBe('needsFraming');
    const source = photo(), data = Float32Array.from(source.data, value => value / 255);
    data[(150 * source.width + 150) * 4] = NaN;
    expect(detectNeutralCards({ ...source, data }).status).toBe('needsFraming');
  });
});
