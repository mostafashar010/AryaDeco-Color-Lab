import { describe, expect, it } from 'vitest';
import { holdAnchor, MAX_APERTURE_HOLD_FRAMES, sameMarker, type DisplayAnchor } from './apertureAnchor';
import { processTrackingFrame, type TrackingRequest, type WorkerTrackingState } from './tracking.worker';
import { markerCells, type PixelImage } from './marker';

const region = { id: 'auto-display', label: 'A', order: 0, mode: 'solid' as const, polygon: [[1, 1], [9, 1], [9, 9], [1, 9]] as [number, number][], exclusions: [], background: null, layers: null, direction: null, operatorConfirmed: false, selectionMethod: 'autoDetected' as const };
const marker = { x: 10, y: 20, width: 280, height: 20 };
const anchor = (heldFrames?: number): DisplayAnchor => ({ aperture: region, region, marker, ...(heldFrames === undefined ? {} : { heldFrames }) });

describe('holdAnchor (pure)', () => {
  it('needs both a proven anchor and a currently decoded marker', () => {
    expect(holdAnchor(undefined, marker)).toBeUndefined();
    expect(holdAnchor(anchor(), undefined)).toBeUndefined();
  });
  it('carries the anchor, counting consecutive unproven frames', () => {
    const first = holdAnchor(anchor(), marker)!;
    expect(first.heldFrames).toBe(1);
    expect(holdAnchor(first, marker)!.heldFrames).toBe(2);
    expect(first.aperture).toBe(region);
  });
  it('is bounded: the limit-th frame is kept, the next is dropped', () => {
    expect(holdAnchor(anchor(MAX_APERTURE_HOLD_FRAMES - 1), marker)!.heldFrames).toBe(MAX_APERTURE_HOLD_FRAMES);
    expect(holdAnchor(anchor(MAX_APERTURE_HOLD_FRAMES), marker)).toBeUndefined();
    expect(holdAnchor(anchor(), marker, 0)).toBeUndefined();
  });
  it('drops the anchor when the marker, which is printed on phone A, has moved more than one analysis pixel', () => {
    expect(sameMarker(marker, { ...marker, x: 11 })).toBe(true);
    expect(holdAnchor(anchor(), { ...marker, x: 11 })).toBeDefined();
    expect(holdAnchor(anchor(), { ...marker, x: 12 })).toBeUndefined();
    expect(holdAnchor(anchor(), { ...marker, width: 283 })).toBeUndefined();
  });
});

// ---- real worker, real detector -------------------------------------------------------------
function raster(width = 640, height = 480): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([83, 72, 61, 255], i);
  return { width, height, data };
}
function paint(image: PixelImage, x: number, y: number, width: number, height: number, rgb: number[]) {
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) image.data.set([...rgb, 255], (yy * image.width + xx) * 4);
}
/** Phone A (gray rim + blue screen) with its marker below, three fabric swatches on the left. `dx` shifts phone and marker. */
function scene(sequence = 7, dx = 0) {
  const image = raster();
  paint(image, 315 + dx, 105, 270, 180, [119, 119, 119]);
  paint(image, 320 + dx, 110, 260, 170, [93, 137, 167]);
  markerCells(sequence).forEach((bit, i) => paint(image, 310 + dx + i * 10, 300, 10, 20, bit ? [250, 250, 250] : [5, 5, 5]));
  [[170, 94, 81], [177, 99, 86], [103, 141, 157]].forEach((color, i) => paint(image, 45, 80 + i * 70, 170, 70, color));
  return image;
}
const BANDS = { commandSequence: 7, bands: [{ id: 'all', top: 0, bottom: 1, drive: [.4, .5, .6] as [number, number, number] }] };
function request(image: PixelImage, index: number): TrackingRequest {
  return { id: index, generation: 1, phase: 'scene', expectedSequence: undefined, mode: 'cameraMatch', displayBands: BANDS, image: { ...image, data: image.data as Uint8ClampedArray }, frame: { presentedFrames: index, mediaTime: index / 2, width: image.width * 2, height: image.height * 2 } };
}
const WHITE = [255, 255, 255];
/** A light streak across the top of phone A: it splits the detected screen into several pieces, which is the real displayApertureMissing case. */
const streakOnRim = (image: PixelImage) => { paint(image, 300, 95, 300, 100, WHITE); return image; };
/** The same kind of streak but only on rows that lie outside the 15%-85% window used to sample the screen. */
const streakOutsideSample = (image: PixelImage) => { paint(image, 300, 118, 300, 10, WHITE); return image; };

function proven(): WorkerTrackingState {
  const state = processTrackingFrame(request(scene(), 1), null);
  expect(state.displayAnchor).toBeDefined();
  expect(state.tracking.tracking.previewFeedbackRejectionReasons).toEqual([]);
  return state;
}
const reasons = (state: WorkerTrackingState) => state.tracking.tracking.previewFeedbackRejectionReasons ?? [];

describe('proven aperture carried through a reflection (tracking worker)', () => {
  it('holds the proven geometry for a glare frame that cannot re-prove the rim, and says so', () => {
    const state = processTrackingFrame(request(streakOnRim(scene()), 2), proven());
    expect(state.displayAnchor?.heldFrames).toBe(1);
    expect(reasons(state)).not.toContain('screenApertureMissing');
    expect(reasons(state)).not.toContain('screenGeometryUncertain');
    expect(state.tracking.tracking.nextAction).toContain('بازتاب');
    expect(state.tracking.tracking.regions.some(r => r.id === 'auto-display')).toBe(true);
  });
  it('never lets the hold bypass the pixel gates: clipped glare inside the sampled window leaves no band to send', () => {
    const state = processTrackingFrame(request(streakOnRim(scene()), 2), proven());
    expect(state.displayAnchor?.heldFrames).toBe(1);
    expect(reasons(state)).toContain('cameraHighlightClipped');
    // Workbench only posts feedback when screenAppearanceBands covers every commanded band.
    expect(state.tracking.tracking.previewFeedback?.screenAppearanceBands ?? []).toEqual([]);
  });
  it('still delivers the band when the glare stays outside the sampled window and the pixels are clean', () => {
    const state = processTrackingFrame(request(streakOutsideSample(scene()), 2), proven());
    expect(reasons(state)).toEqual([]);
    expect(state.tracking.tracking.previewFeedback?.screenAppearanceBands.map(b => b.id)).toEqual(['all']);
  });
  it('is bounded to MAX_APERTURE_HOLD_FRAMES consecutive glare frames, then reports the aperture as missing', () => {
    let state = proven();
    for (let i = 1; i <= MAX_APERTURE_HOLD_FRAMES; i++) {
      state = processTrackingFrame(request(streakOnRim(scene()), 1 + i), state);
      expect(state.displayAnchor?.heldFrames).toBe(i);
    }
    state = processTrackingFrame(request(streakOnRim(scene()), 2 + MAX_APERTURE_HOLD_FRAMES), state);
    expect(state.displayAnchor).toBeUndefined();
    expect(reasons(state)).toContain('screenApertureMissing');
    expect(state.tracking.tracking.previewFeedback).toBeUndefined();
  });
  it('does not hold when phone A has moved: the marker moves with it', () => {
    const moved = processTrackingFrame(request(streakOnRim(scene(7, 6)), 2), proven());
    expect(moved.displayAnchor).toBeUndefined();
    expect(moved.tracking.tracking.previewFeedback).toBeUndefined();
  });
  it('does not hold when the marker is no longer visible', () => {
    const noMarker = streakOnRim(scene());
    paint(noMarker, 300, 296, 300, 28, [83, 72, 61]);
    const state = processTrackingFrame(request(noMarker, 2), proven());
    expect(state.displayAnchor).toBeUndefined();
    expect(reasons(state)).toContain('markerMissing');
  });
  it('never invents a hold without an earlier proven aperture', () => {
    const state = processTrackingFrame(request(streakOnRim(scene()), 1), null);
    expect(state.displayAnchor).toBeUndefined();
    expect(reasons(state)).toContain('screenApertureMissing');
    expect(state.tracking.tracking.previewFeedback).toBeUndefined();
  });
  it('starts counting again once the rim is proven afresh', () => {
    let state = processTrackingFrame(request(streakOnRim(scene()), 2), proven());
    state = processTrackingFrame(request(streakOnRim(scene()), 3), state);
    expect(state.displayAnchor?.heldFrames).toBe(2);
    state = processTrackingFrame(request(scene(), 4), state);
    expect(state.displayAnchor).toBeDefined();
    expect(state.displayAnchor?.heldFrames).toBeUndefined();
    expect(reasons(state)).toEqual([]);
  });
  it('leaves the response flow alone', () => {
    const state = processTrackingFrame({ ...request(streakOnRim(scene()), 2), purpose: 'response' }, null);
    expect(state.displayAnchor).toBeUndefined();
  });
});
