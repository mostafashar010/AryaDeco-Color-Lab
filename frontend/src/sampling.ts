import type { PixelImage, Rect } from './marker';
export type Point = [number, number];
export type Region = { id: string; label: string; order: number; mode: 'solid' | 'bands' | 'patterned'; polygon: Point[]; exclusions: Point[][]; background: string | null; layers: number | null; direction: string | null; operatorConfirmed: boolean; selectionMethod?: 'manual' | 'autoDetected' };
export type Frame = { id: string; capturedAt: number; pixels: number[][]; colorSpace: 'srgb' | 'display-p3'; encoding: 'encoded'; blockIds: number[]; pixelCount: number; excludedCount: number; source: 'videoCanvas' | 'replay'; settingsFingerprint: string; markerSequence: number | null; markerPixels?: number[][]; presentedFrames?: number; mediaTime?: number; width?: number; height?: number; regionId?: string; roi?: Point[]; exclusions?: Point[][]; sharpnessStatus?: 'notAssessed' };
export function bounds(polygon: Point[]): Rect {
  if (polygon.length < 3 || polygon.some(p => p.length !== 2 || p.some(n => !Number.isFinite(n) || n < 0))) throw new Error('هندسهٔ ناحیه نامعتبر است.');
  const x = Math.floor(Math.min(...polygon.map(p => p[0]))); const y = Math.floor(Math.min(...polygon.map(p => p[1])));
  return { x, y, width: Math.ceil(Math.max(...polygon.map(p => p[0]))) - x, height: Math.ceil(Math.max(...polygon.map(p => p[1]))) - y };
}
export function contains(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function sampleRegion(image: PixelImage, offset: { x: number; y: number }, region: Region) {
  const b = bounds(region.polygon);
  const pixels: number[][] = [], blockIds: number[] = [];
  const buckets: number[][][] = Array.from({ length: 16 }, () => []);
  const seen = Array(16).fill(0);
  let pixelCount = 0, excludedCount = 0;
  const scale = image.data instanceof Uint8ClampedArray ? 255 : 1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const point: Point = [offset.x + x + 0.5, offset.y + y + 0.5];
    if (!contains(point, region.polygon)) continue;
    if (region.exclusions.some(p => contains(point, p))) { excludedCount++; continue; }
    const i = (y * image.width + x) * 4;
    const rgb = [0, 1, 2].map(c => Number(image.data[i + c]) / scale);
    if (rgb.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('پیکسل خارج از دامنه؛ تبدیل یا clip خودکار انجام نشد.');
    const block = Math.min(3, Math.floor((point[1] - b.y) / Math.max(1, b.height) * 4)) * 4 + Math.min(3, Math.floor((point[0] - b.x) / Math.max(1, b.width) * 4));
    // Separated block reservoirs retain source pixels, not synthetic block averages.
    pixelCount++;
    const bucket = buckets[block];
    seen[block]++;
    if (bucket.length < 32) bucket.push(rgb);
    else { const stride = Math.max(1, Math.ceil(b.width * b.height / 512)); if (seen[block] % stride === 0) bucket[Math.floor(seen[block] / stride) % 32] = rgb; }
  }
  buckets.forEach((bucket, block) => bucket.forEach(rgb => { pixels.push(rgb); blockIds.push(block); }));
  if (!pixels.length) throw new Error('ناحیه پیکسل قابل اندازه‌گیری ندارد.');
  return { pixels, blockIds, pixelCount: pixelCount + excludedCount, excludedCount };
}
