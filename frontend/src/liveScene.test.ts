import { describe, expect, it, vi } from 'vitest';
import * as swatchDetection from './swatchDetection';
import * as neutralCards from './neutralCards';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pythonBin, realPhotoPath } from './testPaths';
import { markerCells, decodeMarker, sampleMarker, type PixelImage, type Rect } from './marker';
import * as markerDecoder from './marker';
import { bounds, contains } from './sampling';
import { detectLiveScene } from './liveScene';

function image(width = 640, height = 480): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([83, 72, 61, 255], i);
  return { width, height, data };
}
function paint(target: PixelImage, rect: Rect, rgb: number[]) {
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    target.data.set([...rgb, 255], (y * target.width + x) * 4);
  }
}
function display(target: PixelImage, sequence = 0x5a53d1, x = 310, y = 300, cell = 10) {
  const marker = { x, y, width: cell * 28, height: 20 };
  const screen = { x: x + 10, y: y - 190, width: cell * 28 - 20, height: 170 };
  paint(target, { x: screen.x - 5, y: screen.y - 5, width: screen.width + 10, height: screen.height + 10 }, [119, 119, 119]);
  paint(target, screen, [93, 137, 167]);
  markerCells(sequence).forEach((bit, index) => paint(target, { x: x + index * cell, y, width: cell, height: 20 }, bit ? [250, 250, 250] : [5, 5, 5]));
  return { marker, screen };
}
function strips(target: PixelImage) {
  [[170, 94, 81], [177, 99, 86], [103, 141, 157]].forEach((rgb, index) => paint(target, { x: 45, y: 80 + index * 70, width: 170, height: 70 }, rgb));
}

function borderedFractionalMarker(width = 108, sequence = 315, slant = 0, border = 1): PixelImage {
  const target = image(640, 640), bits = markerCells(sequence), left = 233, top = 300, stripHeight = 18;
  // Pixel area coverage approximates a camera's antialiased fractional grid.
  for (let y = top - 2; y < top + stripHeight + 6; y++) for (let x = left - 2; x < left + width + 2; x++) {
    let value = 0, count = 0;
    for (const dy of [.125, .375, .625, .875]) for (const dx of [.125, .375, .625, .875]) {
      const xx = x + dx - left, yy = y + dy - top - xx * slant;
      if (xx >= -border && xx < width + border && yy >= -border && yy < stripHeight + border) {
        value += xx >= 0 && xx < width && yy >= 0 && yy < stripHeight ? (bits[Math.floor(xx * 28 / width)] ? 250 : 15) : 119;
      } else value += 48;
      count++;
    }
    paint(target, { x, y, width: 1, height: 1 }, [value / count, value / count, value / count]);
  }
  return target;
}

describe('automatic live scene geometry', () => {
  it('bounds decoding work for an over-height striped distractor without increasing test timeouts', () => {
    const target = image(640, 640);
    paint(target, { x: 232, y: 19, width: 110, height: 602 }, [119, 119, 119]);
    markerCells(0).forEach((bit, index) => paint(target, { x: Math.round(233 + index * 108 / 28), y: 20, width: Math.round(233 + (index + 1) * 108 / 28) - Math.round(233 + index * 108 / 28), height: 600 }, bit ? [250, 250, 250] : [15, 15, 15]));
    const decode = vi.spyOn(markerDecoder, 'decodeMarker'), started = performance.now();
    try {
      const result = detectLiveScene(target, undefined, { purpose: 'response' });
      console.info(`marker-tall: ${(performance.now() - started).toFixed(1)}ms, ${decode.mock.calls.length} decodes`);
      expect(result.marker).toBeUndefined();
      expect(decode.mock.calls.length).toBeLessThan(1000);
    } finally { decode.mockRestore(); }
  });
  it.each([[5, 157], [6, 157], [8, 142]])('rejects rim-colored tail occlusion of %s pixels even when the wrong alias is expected', (pixels, alias) => {
    const target = borderedFractionalMarker();
    paint(target, { x: 341 - pixels, y: 299, width: pixels + 1, height: 20 }, [119, 119, 119]);
    for (const expected of [undefined, alias]) {
      expect(detectLiveScene(target, expected, { purpose: 'response' }).marker).toBeUndefined();
    }
  });
  it('retains ambiguity when a legacy marker precedes a second small bordered marker', () => {
    const target = borderedFractionalMarker(); display(target, 315, 20, 500, 6);
    const result = detectLiveScene(target, 315, { purpose: 'response' });
    expect(result.evidence.markerCandidates).toBe(2); expect(result.marker).toBeUndefined();
  });
  it('bounds repeated decoding work per observed strip at 640 and 480 analysis pixels', () => {
    const source = borderedFractionalMarker(108, 315, 0, 2);
    const data = new Uint8ClampedArray(execFileSync(pythonBin(), ['-c', 'from PIL import Image; import sys; im=Image.frombytes("RGBA",(640,640),sys.stdin.buffer.read()); sys.stdout.buffer.write(im.resize((480,480),Image.Resampling.BOX).tobytes())'], { input: source.data, maxBuffer: 1_000_000 }));
    const counts: number[] = [];
    for (const target of [source, { width: 480, height: 480, data }]) {
      const decode = vi.spyOn(markerDecoder, 'decodeMarker'), started = performance.now();
      try {
        const result = detectLiveScene(target, 315, { purpose: 'response' });
        expect(result.evidence.markerSequence).toBe(315);
        counts.push(decode.mock.calls.length);
        console.info(`marker-cost ${target.width}: ${(performance.now() - started).toFixed(1)}ms, ${decode.mock.calls.length} decodes`);
      } finally { decode.mockRestore(); }
    }
    expect(Math.max(...counts)).toBeLessThan(100);
  });
  it.each([0, 1, 0xffffff, 0x800000, 0x5a53d1])('keeps complete bordered fractional geometry independent of repeated end bits: %s', sequence => {
    const result = detectLiveScene(borderedFractionalMarker(108, sequence), sequence, { purpose: 'response' });
    expect(result.evidence.markerSequence, JSON.stringify(result.evidence)).toBe(sequence);
    expect(result.marker!.width).toBeCloseTo(108, 0);
  });
  it('decodes a 108px camera strip after an antialiased 640-to-480 analysis resize', () => {
    const source = borderedFractionalMarker(108, 315, 0, 2);
    const data = new Uint8ClampedArray(execFileSync(pythonBin(), ['-c', 'from PIL import Image; import sys; im=Image.frombytes("RGBA",(640,640),sys.stdin.buffer.read()); sys.stdout.buffer.write(im.resize((480,480),Image.Resampling.BOX).tobytes())'], { input: source.data, maxBuffer: 1_000_000 }));
    const target = { width: 480, height: 480, data };
    const result = detectLiveScene(target, 315, { purpose: 'response' });
    expect(result.evidence.markerSequence, JSON.stringify(result.evidence)).toBe(315);
    expect(result.marker!.width).toBeGreaterThanOrEqual(80); expect(result.marker!.width).toBeLessThanOrEqual(82);
    expect(decodeMarker(sampleMarker(target, result.marker!, { purpose: 'analysisGeometry' }))).toBe(315);
  });
  it('uses native end-edge evidence when a 2160px source is analyzed at 640px', () => {
    const source = borderedFractionalMarker(), target = image(2160, 2160);
    for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
      const offset = (Math.floor(y * 640 / 2160) * 640 + Math.floor(x * 640 / 2160)) * 4;
      target.data.set(source.data.subarray(offset, offset + 4), (y * target.width + x) * 4);
    }
    const result = detectLiveScene(target, 315, { purpose: 'response' });
    expect(result.evidence.markerSequence, JSON.stringify(result.evidence)).toBe(315);
    expect(decodeMarker(sampleMarker(target, result.marker!))).toBe(315);
    expect(result.marker!.width).toBeGreaterThan(360); expect(result.marker!.width).toBeLessThan(368);
  });
  it.each(['rightBorder', 'topBorder', 'clip', 'noMarker'] as const)('rejects incomplete small marker evidence: %s', failure => {
    const target = borderedFractionalMarker();
    if (failure === 'rightBorder') paint(target, { x: 341, y: 299, width: 1, height: 20 }, [48, 48, 48]);
    if (failure === 'topBorder') paint(target, { x: 233, y: 299, width: 108, height: 1 }, [48, 48, 48]);
    if (failure === 'clip') paint(target, { x: 310, y: 299, width: 32, height: 20 }, [48, 48, 48]);
    if (failure === 'noMarker') paint(target, { x: 232, y: 299, width: 110, height: 20 }, [119, 119, 119]);
    const result = detectLiveScene(target, 315, { purpose: 'response' });
    expect(result.marker).toBeUndefined(); expect(result.displayRegion).toBeUndefined();
  });
  it('refuses the replay sequence instead of fitting the expected bits', () => {
    const target = borderedFractionalMarker();
    const result = detectLiveScene(target, 940, { purpose: 'response' });
    expect(result.marker).toBeUndefined();
    expect(result.evidence.reason).toBe('displayMarkerMismatch');
    expect(result.evidence.markerCandidates).toBe(1);
  });
  it('rejects shifted and oversized analysis ROIs rather than decoding outside the physical strip', () => {
    const target = borderedFractionalMarker();
    for (const roi of [{ x: 233 + 4, y: 303, width: 108, height: 10 }, { x: 231.5, y: 303, width: 117.5, height: 10 }]) {
      expect(() => decodeMarker(sampleMarker(target, roi, { purpose: 'analysisGeometry' }))).toThrow();
    }
  });
  it('rejects analysis rows that disagree and strips below two pixels per cell', () => {
    const target = borderedFractionalMarker(81), other = borderedFractionalMarker(81, 314);
    for (let y = 308; y < 318; y++) target.data.set(other.data.subarray(y * 640 * 4, (y + 1) * 640 * 4), y * 640 * 4);
    expect(() => sampleMarker(target, { x: 233, y: 300, width: 81, height: 18 }, { purpose: 'analysisGeometry' })).toThrow();
    expect(() => sampleMarker(target, { x: 233, y: 300, width: 55, height: 18 }, { purpose: 'analysisGeometry' })).toThrow();
    expect(detectLiveScene(borderedFractionalMarker(55), 315, { purpose: 'response' }).marker).toBeUndefined();
  });
  it('decodes mildly slanted antialiased fractional cells using a shared consistent row interior', () => {
    const target = borderedFractionalMarker(108, 315, .02);
    const result = detectLiveScene(target, 315, { purpose: 'response' });
    expect(result.evidence.markerSequence, JSON.stringify(result.evidence)).toBe(315);
    expect(decodeMarker(sampleMarker(target, result.marker!, { purpose: 'analysisGeometry' }))).toBe(315);
    expect(result.marker!.x + result.marker!.width).toBeLessThanOrEqual(342);
  });
  it('uses explicit analysis sampling for a bordered 81px strip while scientific sampling stays strict', () => {
    const target = borderedFractionalMarker(81);
    const result = detectLiveScene(target, 315, { purpose: 'response' });
    expect(result.evidence.markerSequence, JSON.stringify(result.evidence)).toBe(315);
    expect(() => sampleMarker(target, result.marker!)).toThrow();
    expect(decodeMarker(sampleMarker(target, result.marker!, { purpose: 'analysisGeometry' }))).toBe(315);
    expect(sampleMarker(target, result.marker!, { purpose: 'analysisGeometry' })).toHaveLength(28);
  });
  it('fits the complete bordered 108px strip rather than extrapolating rounded 4px sentinel pitch', () => {
    const target = borderedFractionalMarker();
    const result = detectLiveScene(target, 315, { purpose: 'response' });
    expect(result.evidence.markerSequence, JSON.stringify(result.evidence)).toBe(315);
    expect(result.marker!.x).toBeCloseTo(233, 0);
    expect(result.marker!.width).toBeCloseTo(108, 0);
    expect(result.marker!.x + result.marker!.width).toBeLessThanOrEqual(342);
    expect(() => sampleMarker(target, result.marker!)).toThrow();
  });
  it('does not authorize the visible lower half as the entire aperture without an enclosing rim', () => {
    const target = image();
    paint(target, { x: 320, y: 195, width: 260, height: 85 }, [93, 137, 167]);
    markerCells(7).forEach((bit, index) => paint(target, { x: 310 + index * 10, y: 300, width: 10, height: 20 }, bit ? [250, 250, 250] : [5, 5, 5]));
    const result = detectLiveScene(target, 7, { displayLayout: 'liveBands' });
    expect(result.marker).toBeDefined();
    expect(result.apertureFeedbackSafe).not.toBe(true);
  });

  it('withholds feedback when rim-colored top content makes the apparent rim thickness incoherent', () => {
    const target = image(); display(target, 7);
    paint(target, { x: 320, y: 110, width: 260, height: 15 }, [119, 119, 119]);
    const result = detectLiveScene(target, 7, { displayLayout: 'liveBands' });
    expect(result.marker).toBeDefined(); expect(result.displayRegion).toBeDefined();
    expect(result.apertureFeedbackSafe).toBe(false);
  });

  it('uses the enclosed inner aperture of the left phone black frame for feedback', () => {
    const target = image();
    paint(target, { x: 18, y: 68, width: 180, height: 270 }, [85, 85, 85]);
    paint(target, { x: 23, y: 73, width: 170, height: 224 }, [0, 0, 0]);
    paint(target, { x: 25, y: 75, width: 166, height: 110 }, [100, 80, 60]);
    paint(target, { x: 25, y: 185, width: 166, height: 110 }, [150, 120, 100]);
    markerCells(7).forEach((bit, index) => paint(target, { x: 24 + index * 6, y: 306, width: 6, height: 12 }, bit ? [255, 255, 255] : [0, 0, 0]));
    const result = detectLiveScene(target, 7, { displayLayout: 'liveBands' });
    expect(result.marker).toBeDefined();
    expect(result.apertureFeedbackSafe).toBe(true);
    expect(bounds(result.displayAperture!.polygon)).toEqual({ x: 25, y: 75, width: 166, height: 220 });
  });
  // These three tests need the original (private, uncommitted) camera photos. They run only when
  // COLORLAB_REAL_PHOTO_DIR points at a folder containing them; otherwise they are skipped, not failed.
  const nativePhoto=(suffix:string)=>realPhotoPath(`photo_2026-10-14_${suffix==='55'?'07-21-55':`07-22-${suffix}`}.jpg`);
  describe.skipIf(!['01','00','55'].every(s=>nativePhoto(s)))('native 07 camera photos (private files, set COLORLAB_REAL_PHOTO_DIR)',()=>{
  it.each([['01',294],['00',421],['55',563]] as const)('keeps native 07 screenshot %s camera pixels separate from UI and does not invent expected marker bits',(suffix,top)=>{
    const data=new Uint8ClampedArray(execFileSync(pythonBin(),['-c',`from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert("RGBA").crop((48,${top},543,${top+495})); sys.stdout.buffer.write(im.tobytes())`,nativePhoto(suffix)!],{maxBuffer:2_000_000}));
    const target={width:495,height:495,data};
    const result=detectLiveScene(target,undefined,{purpose:'response',requireReferenceIdentity:false});
    if(suffix!=='55'){
      expect(result.evidence.reason).toBe('displayMarkerMissing');
      expect(result.marker).toBeUndefined();expect(result.displayRegion).toBeUndefined();
      expect(result.responseWitness?.candidateCount).toBe(suffix==='01'?1:2);
    }else{
      expect(result.marker,JSON.stringify(result.evidence)).toBeDefined();
      expect(result.evidence.markerSequence).toBe(7);
      expect(result.evidence.reason).toBe('displayApertureMissing');
      expect(decodeMarker(sampleMarker(target,result.marker!))).toBe(result.evidence.markerSequence);
      const stale=detectLiveScene(target,(result.evidence.markerSequence!+1)%0x1000000,{purpose:'response'});
      expect(stale.marker).toBeUndefined();expect(stale.evidence.reason).toBe('displayMarkerMismatch');
    }
    expect(result.fabricRegions).toEqual([]);
  });
  });
  it.each(['12', '14', '16'])('uses only the actual camera crop in screenshot %s and never admits UI or stale screen proof', suffix => {
    const fixture = JSON.parse(readFileSync(`src/fixtures/live-screenshot-${suffix}.json`, 'utf8'));
    const data = new Uint8ClampedArray(execFileSync(pythonBin(), ['-c', 'from PIL import Image; import sys; sys.stdout.buffer.write(Image.open(sys.argv[1]).convert("RGBA").tobytes())', `src/fixtures/live-screenshot-${suffix}.png`], { maxBuffer: 2_000_000 }));
    const result = detectLiveScene({ width: fixture.size[0], height: fixture.size[1], data }, undefined, { requireReferenceIdentity: false, displayLayout: 'liveBands' });
    expect(fixture.humanConfirmed).toBe(false);
    expect(result.displayRegion).toBeUndefined();
    expect(result.marker).toBeUndefined();
    expect(result.fabricRegions.length).toBeGreaterThanOrEqual(4);
    expect(result.fabricRegions.length).toBeLessThanOrEqual(14);
    expect(result.fabricRegions.every(r => r.exclusions.length <= 32 && !r.operatorConfirmed)).toBe(true);
    result.fabricRegions.forEach(r => r.polygon.forEach(([x, y]) => { expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(fixture.size[0]); expect(y).toBeLessThanOrEqual(fixture.size[1]); }));
    if (suffix === '16') expect(result.nextAction).toMatch(/عمودی|۹۰|90/);
  });
  it('classifies a readable vertical marker as unsupported pose, without horizontal capture authorization', () => {
    const target = image();
    markerCells(77).forEach((bit, index) => paint(target, { x: 40, y: 80 + index * 10, width: 16, height: 10 }, bit ? [250, 250, 250] : [5, 5, 5]));
    const result = detectLiveScene(target, 77);
    expect(result.evidence.reason).toBe('displayMarkerOrientationUnsupported');
    expect(result.evidence.markerOrientation).toBe('vertical');
    expect(result.marker).toBeUndefined();
    expect(result.displayRegion).toBeUndefined();
    expect(result.nextAction).toMatch(/عمودی|۹۰|90/);
  });
  it('classifies raster pixels without allocating RGB arrays on every scan comparison', () => {
    const target = image(); display(target); strips(target);
    const baseline = detectLiveScene(target, 0x5a53d1);
    const arrays = vi.spyOn(Array, 'from');
    let result: ReturnType<typeof detectLiveScene>, calls: number;
    try { result = detectLiveScene(target, 0x5a53d1); calls = arrays.mock.calls.length; }
    finally { arrays.mockRestore(); }
    expect(result!).toEqual(baseline);
    expect(result!.status).toBe('ready');
    expect(calls!).toBeLessThan(5000);
  });
  it('performs each scene detector once even when a readable marker is stale', () => {
    const target = image();
    for (let band = 0; band < 8; band++) paint(target, { x: 0, y: band * 60, width: 640, height: 60 }, [110 + band * 10, 75 + band * 8, 65 + band * 7]);
    display(target, 17, 20, 300, 8);
    const baseline = detectLiveScene(target, 18, { requireReferenceIdentity: false, displayLayout: 'liveBands' });
    const swatches = vi.spyOn(swatchDetection, 'detectSwatchLayout');
    const cards = vi.spyOn(neutralCards, 'detectNeutralCards');
    let result: ReturnType<typeof detectLiveScene>, swatchCalls: number, cardCalls: number;
    try {
      result = detectLiveScene(target, 18, { requireReferenceIdentity: false, displayLayout: 'liveBands' });
      swatchCalls = swatches.mock.calls.length; cardCalls = cards.mock.calls.length;
    } finally { swatches.mockRestore(); cards.mockRestore(); }
    expect(result!).toEqual(baseline);
    expect(result!.evidence.reason).toBe('displayMarkerMismatch');
    expect(swatchCalls!).toBe(1);
    expect(cardCalls!).toBe(1);
  });
  it('retains real-cloth geometry in a synthetic screenshot-like composite with actual photo card crops', () => {
    // Synthetic layout, not the unavailable raw screenshot or human-confirmed truth.
    const target: PixelImage = { width: 640, height: 480, data: new Uint8ClampedArray(execFileSync(pythonBin(), ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert("RGBA").resize((640,480)); sys.stdout.buffer.write(im.tobytes())', '../references/02-swatch-bands.jpg'], { maxBuffer: 2_000_000 })) };
    const cards = JSON.parse(readFileSync('src/fixtures/neutral-cards-real.json', 'utf8'));
    const pixels = Buffer.from(cards.rgbaBase64, 'base64');
    const centers = [[140, 60], [140, 155], [148, 246]];
    const positions = [[260, 50], [465, 85], [345, 285]];
    positions.forEach(([left, top], index) => {
      for (let y = 0; y < 75; y++) for (let x = 0; x < 120; x++) {
        const xx = centers[index][0] - 40 + Math.floor(x * 80 / 120), yy = centers[index][1] - 25 + Math.floor(y * 50 / 75);
        const dx = index === 2 ? Math.floor(y * 0.3) : 0;
        target.data.set(pixels.subarray((yy * cards.width + xx) * 4, (yy * cards.width + xx) * 4 + 4), ((top + y) * 640 + left + x + dx) * 4);
      }
    });
    paint(target, { x: 18, y: 35, width: 158, height: 240 }, [30, 34, 41]);
    const result = detectLiveScene(target);
    expect(result.evidence.reason).toBe('displayMarkerMissing');
    // Updated cross-column persistence rejects an old texture/fold split; this
    // synthetic composite does not establish an exact physical swatch count.
    expect(result.fabricRegions.length).toBeGreaterThanOrEqual(7);
    expect(result.fabricRegions.length).toBeLessThanOrEqual(14);
    expect(result.fabricRegions.some(r => r.exclusions.length > 0)).toBe(true);
    expect(result.status).toBe('needsFraming');
  });
  it('retains full-width occluded band proposals while the left phone has no marker', () => {
    const target = image();
    for (let band = 0; band < 8; band++) paint(target, { x: 0, y: band * 60, width: 640, height: 60 }, [110 + band * 10, 75 + band * 8, 65 + band * 7]);
    paint(target, { x: 20, y: 45, width: 160, height: 250 }, [30, 34, 41]);
    paint(target, { x: 270, y: 70, width: 120, height: 80 }, [30, 30, 30]);
    paint(target, { x: 450, y: 100, width: 120, height: 80 }, [145, 145, 145]);
    paint(target, { x: 350, y: 310, width: 120, height: 80 }, [230, 230, 230]);
    const result = detectLiveScene(target);
    expect(result.status).toBe('needsFraming');
    expect(result.evidence).toMatchObject({ reason: 'displayMarkerMissing', geometryOnly: true });
    expect(result.fabricRegions.length).toBeGreaterThanOrEqual(6);
    expect(result.neutralCandidates.length).toBeGreaterThanOrEqual(2);
    expect(result.fabricRegions.every(region => !region.operatorConfirmed && region.selectionMethod === 'autoDetected')).toBe(true);
    expect(result.displayRegion).toBeUndefined();
  });
  it.each([20, 350])('keeps occluded full-width fabric with a marked phone at x=%s', x => {
    const target = image();
    for (let band = 0; band < 8; band++) paint(target, { x: 0, y: band * 60, width: 640, height: 60 }, [110 + band * 10, 75 + band * 8, 65 + band * 7]);
    display(target, 77, x, 300, 8);
    const result = detectLiveScene(target, 77, { requireReferenceIdentity: false });
    expect(result.status).toBe('ready');
    expect(result.fabricRegions.length).toBeGreaterThanOrEqual(6);
    expect(result.marker).toBeDefined();
    expect(result.fabricRegions.every(region => region.exclusions.length > 0)).toBe(true);
  });
  it('finds a moderate sloping marker with fractional cells but retains rectangular capture proof', () => {
    const target = image(); strips(target);
    const sequence = 0x5a53d1, x = 310, cell = 10;
    paint(target, { x: 320, y: 110, width: 260, height: 170 }, [93, 137, 167]);
    markerCells(sequence).forEach((bit, index) => paint(target, { x: x + index * cell, y: 300 + Math.floor(index / 4), width: cell, height: 20 }, bit ? [250, 250, 250] : [5, 5, 5]));
    const result = detectLiveScene(target, sequence);
    expect(result.marker).toBeDefined();
    expect(decodeMarker(sampleMarker(target, result.marker!))).toBe(sequence);
    expect(result.evidence.markerSequence).toBe(sequence);
  });
  it('excludes a stale but readable phone marker neighborhood without accepting its display proof', () => {
    const target = image();
    for (let band = 0; band < 8; band++) paint(target, { x: 0, y: band * 60, width: 640, height: 60 }, [110 + band * 10, 75 + band * 8, 65 + band * 7]);
    const screen = display(target, 17, 20, 300, 8).screen;
    const result = detectLiveScene(target, 18, { requireReferenceIdentity: false, displayLayout: 'liveBands' });
    expect(result.evidence.reason).toBe('displayMarkerMismatch');
    expect(result.status).toBe('needsFraming');
    expect(result.marker).toBeUndefined();
    expect(result.displayRegion).toBeUndefined();
    expect(result.fabricRegions.length).toBeGreaterThanOrEqual(5);
    expect(result.fabricRegions.every(region => region.exclusions.some(p => contains([screen.x + screen.width / 2, screen.y + screen.height / 2], p)))).toBe(true);
  });
  it('does not echo a bounded screen-only band stack into live preview when its marker is hidden', () => {
    const target = image();
    for (let band = 0; band < 6; band++) paint(target, { x: 320, y: 90 + band * 40, width: 260, height: 40 }, [60 + band * 20, 85 + band * 10, 170 - band * 15]);
    const result = detectLiveScene(target, undefined, { requireReferenceIdentity: false, displayLayout: 'liveBands' });
    expect(result.fabricRegions).toEqual([]);
    expect(result.evidence.reason).toBe('displayMarkerMissing');
  });
  it.each([20, 350])('excludes an actually bounded multicolor display aperture at x=%s without a uniform patch', x => {
    const target = image();
    for (let band = 0; band < 8; band++) paint(target, { x: 0, y: band * 60, width: 640, height: 60 }, [110 + band * 10, 75 + band * 8, 65 + band * 7]);
    const original = display(target, 17, x, 300, 8);
    for (let band = 0; band < 5; band++) paint(target, { x: original.screen.x, y: original.screen.y + band * 34, width: original.screen.width, height: 34 }, [40 + band * 30, 75 + band * 15, 150 - band * 20]);
    const result = detectLiveScene(target, 17, { requireReferenceIdentity: false, displayLayout: 'liveBands' });
    expect(result.marker).toBeDefined();
    expect(result.displayRegion).toBeDefined();
    const rect = bounds(result.displayRegion!.polygon);
    expect(rect.height).toBeGreaterThan(140);
    expect(result.fabricRegions.length).toBeGreaterThanOrEqual(6);
    expect(result.fabricRegions.every(region => region.exclusions.some(p => contains([original.screen.x + original.screen.width / 2, original.screen.y + 85], p)))).toBe(true);
    expect(result.evidence.geometryOnly).toBe(true);
  });
  it.each([1, 0xffffff, 0x5a53d1])('finds the CSS fractional-grid marker for sequence %s', sequence => {
    const target = image(390, 844);
    const x = 17.59375, cell = 12.65625, y = 730;
    paint(target, { x: 35, y: 155, width: 320, height: 550 }, [93, 137, 167]);
    markerCells(sequence).forEach((bit, index) => paint(target, { x: Math.round(x + index * cell), y, width: Math.round(x + (index + 1) * cell) - Math.round(x + index * cell), height: 28 }, bit ? [255, 255, 255] : [0, 0, 0]));
    const result = detectLiveScene(target, sequence);
    expect(result.marker).toBeDefined();
    expect(result.evidence.markerCandidates).toBe(1);
    expect(decodeMarker(sampleMarker(target, result.marker!))).toBe(sequence);
    expect(Math.abs(result.marker!.x - x)).toBeLessThan(1.5);
    expect(Math.abs(result.marker!.width - cell * 28)).toBeLessThan(2);
    expect(result.displayRegion).toBeDefined();
  });
  it('locates the actual raster marker and the separate flat display patch without ROI input', () => {
    const target = image();
    const original = display(target);
    const result = detectLiveScene(target, 0x5a53d1);
    expect(result.marker).toBeDefined();
    expect(decodeMarker(sampleMarker(target, result.marker!))).toBe(0x5a53d1);
    expect(result.marker!.x).toBeCloseTo(original.marker.x, 0);
    expect(result.marker!.width).toBeCloseTo(original.marker.width, 0);
    expect(result.displayRegion?.operatorConfirmed).toBe(false);
    expect(result.displayRegion?.source).toBe('autoDetected');
    const patch = bounds(result.displayRegion!.polygon);
    expect(patch.x).toBeGreaterThan(original.screen.x);
    expect(patch.y).toBeGreaterThan(original.screen.y);
    expect(patch.x + patch.width).toBeLessThan(original.screen.x + original.screen.width);
    expect(patch.y + patch.height).toBeLessThan(original.screen.y + original.screen.height);
    expect(result.nextAction).toMatch(/[\u0600-\u06ff]/);
    expect(result.evidence.markerSequence).toBe(0x5a53d1);
    expect(result.evidence.geometryOnly).toBe(true);
  });

  it.each(['horizontal', 'vertical'] as const)('uses observed screen edges rather than %s patch RGB uniformity', direction => {
    const target = image();
    const { screen } = display(target, 7);
    const baseline = detectLiveScene(target, 7, { purpose: 'response' });
    for (let y = screen.y; y < screen.y + screen.height; y++) for (let x = screen.x; x < screen.x + screen.width; x++) {
      const delta = direction === 'horizontal' ? Math.round((x - screen.x) * 32 / (screen.width - 1)) : Math.round((y - screen.y) * 40 / (screen.height - 1));
      paint(target, { x, y, width: 1, height: 1 }, [93 + delta, 137 + delta, 167 + delta]);
    }
    const result = detectLiveScene(target, 7, { purpose: 'response' });
    expect(result.evidence.markerSequence).toBe(7);
    expect(result.displayRegion, JSON.stringify(result.evidence)).toBeDefined();
    expect(result.displayRegion!.polygon).toEqual(baseline.displayRegion!.polygon);
    expect(result.displayRegion!.operatorConfirmed).toBe(false);
  });

  it('retains a bounded aperture when camera blur spreads border contrast over several pixels', () => {
    const target = image(); const { screen } = display(target, 7);
    const rgba = execFileSync(pythonBin(), ['-c', 'from PIL import Image,ImageFilter; import sys; im=Image.frombytes("RGBA",(640,480),sys.stdin.buffer.read()); sys.stdout.buffer.write(im.filter(ImageFilter.GaussianBlur(4)).tobytes())'], { input: target.data, maxBuffer: 2_000_000 });
    target.data.set(rgba);
    markerCells(7).forEach((bit, index) => paint(target, { x: 310 + index * 10, y: 300, width: 10, height: 20 }, bit ? [250, 250, 250] : [5, 5, 5]));
    const result = detectLiveScene(target, 7, { purpose: 'response' });
    expect(result.marker).toBeDefined();
    expect(result.displayRegion, JSON.stringify(result.evidence)).toBeDefined();
    const b = bounds(result.displayRegion!.polygon);
    expect(b.x).toBeGreaterThan(screen.x); expect(b.y).toBeGreaterThan(screen.y);
    expect(b.x + b.width).toBeLessThan(screen.x + screen.width);
    expect(b.y + b.height).toBeLessThan(screen.y + screen.height);
  });

  it('observes mildly tilted screen boundaries without including its bezel', () => {
    const target = image(); display(target, 7);
    paint(target, { x: 315, y: 95, width: 280, height: 190 }, [83, 72, 61]);
    for (let y = 100; y < 280; y++) for (let x = 315; x < 590; x++) {
      const top = 105 + Math.floor((x - 315) / 24), bottom = top + 170;
      const left = 320 + Math.floor((y - 105) / 40), right = left + 260;
      if (y >= top - 5 && y < bottom + 5 && x >= left - 5 && x < right + 5) paint(target, { x, y, width: 1, height: 1 }, [119, 119, 119]);
      if (y >= top && y < bottom && x >= left && x < right) paint(target, { x, y, width: 1, height: 1 }, [93 + Math.floor((x - left) / 8), 137, 167]);
    }
    const result = detectLiveScene(target, 7, { purpose: 'response' });
    expect(result.marker).toBeDefined();
    expect(result.displayRegion, JSON.stringify(result.evidence)).toBeDefined();
    for (const [x, y] of result.displayRegion!.polygon) {
      expect(y).toBeGreaterThan(105 + Math.floor((x - 315) / 24));
      expect(y).toBeLessThan(275 + Math.floor((x - 315) / 24));
      expect(x).toBeGreaterThan(320 + Math.floor((y - 105) / 40));
      expect(x).toBeLessThan(580 + Math.floor((y - 105) / 40));
    }
  });

  it('exposes observed aperture coordinates separately from the inset response sample', () => {
    const target = image(); const { screen } = display(target, 7);
    const result = detectLiveScene(target, 7, { displayLayout: 'liveBands' });
    expect(result.displayAperture).toBeDefined();
    expect(bounds(result.displayAperture!.polygon)).toEqual(screen);
    expect(result.displayAperture!.polygon).not.toEqual(result.displayRegion!.polygon);
    expect(result.displayAperture!.operatorConfirmed).toBe(false);
    expect(result.apertureFeedbackSafe).toBe(true);
  });

  it('does not authorize band-fraction feedback from an inset tilted aperture approximation', () => {
    const target = image(); display(target, 7);
    paint(target, { x: 315, y: 100, width: 280, height: 185 }, [83, 72, 61]);
    for (let y = 110; y < 280; y++) paint(target, { x: 320 + Math.floor((y - 110) / 30), y, width: 260, height: 1 }, [93, 137, 167]);
    const result = detectLiveScene(target, 7);
    expect(result.displayRegion).toBeDefined();
    expect(result.apertureFeedbackSafe).toBe(false);
  });

  it('retains aligned full aperture feedback with one-pixel camera edge jitter', () => {
    const target = image(); display(target, 7);
    paint(target, { x: 315, y: 105, width: 271, height: 180 }, [119, 119, 119]);
    for (let y = 110; y < 280; y++) paint(target, { x: 320 + y % 2, y, width: 260, height: 1 }, [93, 137, 167]);
    const result = detectLiveScene(target, 7);
    expect(result.displayAperture).toBeDefined();
    expect(result.apertureFeedbackSafe).toBe(true);
    const b = bounds(result.displayAperture!.polygon);
    expect(b.x).toBeGreaterThanOrEqual(320); expect(b.x).toBeLessThanOrEqual(321);
  });

  it('retains full screen edges through JPEG ringing over a smooth gradient', () => {
    const target = image(); const { screen } = display(target, 7);
    for (let y = screen.y; y < screen.y + screen.height; y++) for (let x = screen.x; x < screen.x + screen.width; x++) paint(target, { x, y, width: 1, height: 1 }, [93 + Math.floor((x - screen.x) / 8), 137 + Math.floor((y - screen.y) / 5), 167]);
    target.data.set(execFileSync(pythonBin(), ['-c', 'from PIL import Image; import sys,io; im=Image.frombytes("RGBA",(640,480),sys.stdin.buffer.read()).convert("RGB"); b=io.BytesIO(); im.save(b,"JPEG",quality=55); b.seek(0); sys.stdout.buffer.write(Image.open(b).convert("RGBA").tobytes())'], { input: target.data, maxBuffer: 2_000_000 }));
    const result = detectLiveScene(target, 7);
    expect(result.marker).toBeDefined();
    expect(result.displayRegion, JSON.stringify(result.evidence)).toBeDefined();
    const b = bounds(result.displayRegion!.polygon);
    expect(b.width).toBeGreaterThan(230); expect(b.height).toBeGreaterThan(140);
  });

  it('does not replace sustained screen sides with isolated interior ringing edges', () => {
    const target = image(); const { screen } = display(target, 7);
    for (let y = screen.y + 4; y < screen.y + screen.height - 4; y += 7) paint(target, { x: 550, y, width: 6, height: 1 }, [120, 150, 180]);
    const result = detectLiveScene(target, 7);
    expect(result.displayRegion, JSON.stringify(result.evidence)).toBeDefined();
    expect(bounds(result.displayAperture!.polygon)).toEqual(screen);
  });

  it.each(['top', 'left', 'unbounded'] as const)('rejects %s aperture support even with the correct marker', pose => {
    const target = image(); display(target, 7);
    paint(target, { x: 315, y: 0, width: 280, height: 290 }, [83, 72, 61]);
    if (pose === 'top') paint(target, { x: 320, y: 0, width: 260, height: 280 }, [93, 137, 167]);
    if (pose === 'left') paint(target, { x: 0, y: 110, width: 580, height: 170 }, [93, 137, 167]);
    const result = detectLiveScene(target, 7, { displayLayout: 'liveBands' });
    expect(result.marker).toBeDefined();
    expect(result.displayRegion).toBeUndefined(); expect(result.displayAperture).toBeUndefined();
    expect(result.evidence.reason).toBe('displayApertureMissing');
  });

  it('does not use an internal color boundary as the missing top of a clipped screen', () => {
    const target = image(); display(target, 7);
    paint(target, { x: 315, y: 0, width: 280, height: 290 }, [83, 72, 61]);
    paint(target, { x: 320, y: 0, width: 260, height: 280 }, [93, 137, 167]);
    paint(target, { x: 320, y: 15, width: 260, height: 265 }, [140, 160, 180]);
    const result = detectLiveScene(target, 7, { displayLayout: 'liveBands' });
    expect(result.marker).toBeDefined();
    expect(result.displayRegion).toBeUndefined();
  });

  it('excludes the full observed screen even when its sides extend beyond the marker', () => {
    const target = image(); display(target, 7); strips(target);
    paint(target, { x: 300, y: 110, width: 300, height: 170 }, [93, 137, 167]);
    const result = detectLiveScene(target, 7, { requireReferenceIdentity: false });
    expect(bounds(result.displayAperture!.polygon)).toEqual({ x: 300, y: 110, width: 300, height: 170 });
    expect(result.fabricRegions.length).toBeGreaterThan(0);
    expect(result.fabricRegions.every(region => region.exclusions.some(polygon => contains([598, 200], polygon)))).toBe(true);
  });

  it('fails closed when two disconnected closed apertures compete above one marker', () => {
    const target = image(); display(target, 7);
    paint(target, { x: 315, y: 95, width: 280, height: 190 }, [83, 72, 61]);
    paint(target, { x: 320, y: 145, width: 260, height: 80 }, [93, 137, 167]);
    paint(target, { x: 320, y: 230, width: 260, height: 70 }, [93, 137, 167]);
    const result = detectLiveScene(target, 7);
    expect(result.status).toBe('ambiguous');
    expect(result.displayRegion).toBeUndefined(); expect(result.displayAperture).toBeUndefined();
  });

  it('proposes distinct close-color cloth strips outside the screen, without human confirmation', () => {
    const target = image(); display(target); strips(target);
    const result = detectLiveScene(target, 0x5a53d1);
    expect(result.status).toBe('ready');
    expect(result.fabricRegions).toHaveLength(3);
    result.fabricRegions.forEach((region, index) => {
      const rect = bounds(region.polygon);
      expect(rect.x).toBeGreaterThan(45);
      expect(rect.x + rect.width).toBeLessThan(215);
      expect(rect.y).toBeGreaterThan(80 + index * 70);
      expect(rect.y + rect.height).toBeLessThan(150 + index * 70);
      expect(region.operatorConfirmed).toBe(false);
      expect(region.background).toBeNull();
      expect(region.layers).toBeNull();
      expect(region.source).toBe('autoDetected');
      for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
        expect(contains([x + 0.5, y + 0.5], result.displayRegion!.polygon)).toBe(false);
        result.fabricRegions.slice(0, index).forEach(previous => expect(contains([x + 0.5, y + 0.5], previous.polygon)).toBe(false));
      }
    });
    expect(detectLiveScene(target, 0x5a53d1)).toEqual(result);
  });

  it('retains close-color strip geometry with bounded seeded camera noise of two byte levels', () => {
    const target = image(); display(target); strips(target);
    let seed = 76123;
    for (let y = 80; y < 290; y++) for (let x = 45; x < 215; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = seed % 5 - 2;
      for (let channel = 0; channel < 3; channel++) target.data[(y * target.width + x) * 4 + channel] += noise;
    }
    const result = detectLiveScene(target);
    expect(result.status).toBe('ready');
    expect(result.fabricRegions).toHaveLength(3);
    result.fabricRegions.forEach((region, index) => {
      const rect = bounds(region.polygon);
      expect(rect.y).toBeGreaterThan(80 + index * 70);
      expect(rect.y + rect.height).toBeLessThan(150 + index * 70);
    });
  });

  it('reports rectangular neutral candidates as ambiguous unknown identity, never gray-card IDs', () => {
    const target = image(); display(target); strips(target);
    paint(target, { x: 55, y: 350, width: 100, height: 65 }, [220, 219, 218]);
    paint(target, { x: 190, y: 350, width: 85, height: 65 }, [145, 145, 145]);
    const result = detectLiveScene(target);
    expect(result.status).toBe('ambiguous');
    expect(result.neutralCandidates).toHaveLength(2);
    expect(result.evidence.referenceIdentity).toBe('unknown');
    for (const candidate of result.neutralCandidates) {
      expect(candidate.operatorConfirmed).toBe(false);
      expect(candidate).not.toHaveProperty('Lab');
      expect(candidate).not.toHaveProperty('patchId');
      expect(candidate.id).not.toMatch(/gray|card/i);
      expect(bounds(candidate.polygon).y).toBeGreaterThan(350);
    }
    expect(result.nextAction).toMatch(/مرجع|هویت/);
  });

  it('keeps neutral identities unknown without blocking explicit no-reference geometry matching', () => {
    const target = image(); display(target); strips(target);
    paint(target, { x: 55, y: 350, width: 100, height: 65 }, [220, 219, 218]);
    const result = detectLiveScene(target, undefined, { requireReferenceIdentity: false });
    expect(result.status).toBe('ready');
    expect(result.neutralCandidates).toHaveLength(1);
    expect(result.evidence.referenceIdentity).toBe('unknown');
    expect(result.fabricRegions.every(region => region.selectionMethod === 'autoDetected' && !region.operatorConfirmed)).toBe(true);
    expect(result.displayRegion!.selectionMethod).toBe('autoDetected');
    expect(detectLiveScene(target).status).toBe('ambiguous');
  });

  it('proposes one unique separately bounded colored swatch left of the display', () => {
    const target = image(); display(target);
    paint(target, { x: 40, y: 75, width: 180, height: 220 }, [115, 115, 115]);
    paint(target, { x: 45, y: 80, width: 170, height: 210 }, [170, 94, 81]);
    const result = detectLiveScene(target, undefined, { requireReferenceIdentity: false });
    expect(result.status).toBe('ready');
    expect(result.fabricRegions).toHaveLength(1);
    expect(result.fabricRegions[0].mode).toBe('solid');
    expect(bounds(result.fabricRegions[0].polygon).x).toBeGreaterThan(45);
    expect(result.fabricRegions[0].operatorConfirmed).toBe(false);
  });

  it('rejects a neutral-only rectangle rather than declaring the background or a card to be cloth', () => {
    const target = image(); display(target);
    paint(target, { x: 45, y: 80, width: 170, height: 210 }, [175, 175, 175]);
    const result = detectLiveScene(target, undefined, { requireReferenceIdentity: false });
    expect(result.status).toBe('needsFraming');
    expect(result.fabricRegions).toEqual([]);
    expect(result.neutralCandidates).toHaveLength(1);
  });

  it('does not force the requested bits onto a different fractional marker raster', () => {
    const target = image(390, 844), x = 17.59375, cell = 12.65625;
    markerCells(1).forEach((bit, index) => paint(target, { x: Math.round(x + index * cell), y: 730, width: Math.round(x + (index + 1) * cell) - Math.round(x + index * cell), height: 28 }, bit ? [255, 255, 255] : [0, 0, 0]));
    const result = detectLiveScene(target, 2);
    expect(result.marker).toBeUndefined();
    expect(result.displayRegion).toBeUndefined();
    expect(result.fabricRegions).toEqual([]);
    expect(result.status).toBe('needsFraming');
  });

  it('does not select a fabric container when two separate strip stacks compete', () => {
    const target = image(); display(target); strips(target);
    [[155, 110, 75], [133, 140, 95]].forEach((rgb, index) => paint(target, { x: 45, y: 345 + index * 40, width: 170, height: 40 }, rgb));
    const result = detectLiveScene(target);
    expect(result.status).toBe('ambiguous');
    expect(result.fabricRegions).toEqual([]);
    expect(result.nextAction).toMatch(/پارچه|قاب/);
  });

  it('requires framing for a clipped full-frame cloth instead of returning background as fabric', () => {
    const target = image(); display(target);
    paint(target, { x: 0, y: 0, width: 250, height: 240 }, [165, 125, 100]);
    paint(target, { x: 0, y: 240, width: 250, height: 240 }, [175, 136, 111]);
    const result = detectLiveScene(target);
    expect(result.status).toBe('needsFraming');
    expect(result.fabricRegions).toHaveLength(0);
  });

  it('ignores repetitive stripe distractors not carrying the requested sequence', () => {
    const target = image(); const original = display(target); strips(target);
    for (let i = 0; i < 28; i++) paint(target, { x: 20 + i * 8, y: 410, width: 8, height: 12 }, i % 2 ? [250, 250, 250] : [5, 5, 5]);
    const result = detectLiveScene(target, 0x5a53d1);
    expect(result.marker).toEqual(original.marker);
    expect(result.status).toBe('ready');
  });

  it('refuses two equally valid display markers rather than taking the first', () => {
    const target = image(1000, 600);
    display(target, 17, 50, 350); display(target, 17, 550, 350);
    const result = detectLiveScene(target, 17);
    expect(result.status).toBe('ambiguous');
    expect(result.marker).toBeUndefined();
    expect(result.displayRegion).toBeUndefined();
  });

  it('rejects a tilted marker whose rows cannot establish one rectangular 28-cell stripe', () => {
    const target = image(); display(target); strips(target);
    paint(target, { x: 310, y: 300, width: 280, height: 20 }, [83, 72, 61]);
    markerCells(0x5a53d1).forEach((bit, index) => paint(target, { x: 310 + index * 10, y: 300 + index, width: 10, height: 12 }, bit ? [250, 250, 250] : [5, 5, 5]));
    const result = detectLiveScene(target, 0x5a53d1);
    expect(result.status).toBe('needsFraming');
    expect(result.marker).toBeUndefined();
    expect(result.displayRegion).toBeUndefined();
  });

  it.each([0, 0xffffff, 1, 0x800000])('decodes leading/trailing repeated cells for sequence %s', sequence => {
    const target = image(); display(target, sequence); strips(target);
    const result = detectLiveScene(target, sequence);
    expect(result.evidence.markerSequence).toBe(sequence);
    expect(decodeMarker(sampleMarker(target, result.marker!))).toBe(sequence);
  });

  it('scales detections back to original pixels for a bounded downsampled float RGBA frame', () => {
    const target = image(1280, 960); const marker = display(target, 123, 620, 600, 20).marker;
    [[170, 94, 81], [177, 99, 86]].forEach((rgb, index) => paint(target, { x: 90, y: 160 + index * 140, width: 340, height: 140 }, rgb));
    const float: PixelImage = { ...target, data: Float32Array.from(target.data, value => value / 255) };
    const result = detectLiveScene(float, 123);
    expect(result.marker).toEqual(marker);
    expect(decodeMarker(sampleMarker(float, result.marker!))).toBe(123);
    expect(result.fabricRegions).toHaveLength(2);
    expect(result.fabricRegions.every(region => bounds(region.polygon).x > 90)).toBe(true);
  });

  it('rejects malformed, transparent, undersized, and out-of-range images without manufacturing masks', () => {
    const transparent = image(); transparent.data.fill(0);
    const invalidFloat: PixelImage = { ...image(), data: new Float32Array(640 * 480 * 4).fill(NaN) };
    const invalid: PixelImage[] = [{ ...image(), width: -1 }, { ...image(), data: new Uint8ClampedArray(12) }, image(20, 20), transparent, invalidFloat];
    for (const target of invalid) {
      const result = detectLiveScene(target);
      expect(result.status).toBe('needsFraming');
      expect(result.marker).toBeUndefined();
      expect(result.fabricRegions).toEqual([]);
      expect(result.neutralCandidates).toEqual([]);
    }
  });
});
