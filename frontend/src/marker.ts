export type Rect = { x: number; y: number; width: number; height: number };
export type PixelImage = { data: Uint8ClampedArray | Float16Array | Float32Array; width: number; height: number };
export function markerCells(sequence: number): number[] {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffff) throw new Error('شناسهٔ فرمان از ظرفیت نشانگر خارج است.');
  return [0, 1, 0, 1, ...Array.from({ length: 24 }, (_, i) => (sequence >>> (23 - i)) & 1)];
}
export function decodeMarker(cells: number[][]): number {
  if (cells.length !== 28) throw new Error('نشانگر باید ۲۸ خانه داشته باشد.');
  const luminances = cells.map(c => {
    if (c.length !== 3 || c.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('دادهٔ نشانگر نامعتبر است.');
    return c.reduce((a, b) => a + b, 0) / 3;
  });
  const dark = (luminances[0] + luminances[2]) / 2;
  const light = (luminances[1] + luminances[3]) / 2;
  if (light - dark < 0.25 || Math.abs(luminances[0] - luminances[2]) > 0.15 || Math.abs(luminances[1] - luminances[3]) > 0.15) throw new Error('کنتراست یا هندسهٔ نشانگر قابل تأیید نیست.');
  let sequence = 0;
  for (const value of luminances.slice(4)) {
    if (Math.min(Math.abs(value - dark), Math.abs(value - light)) > (light - dark) * 0.3) throw new Error('خانهٔ مبهم در نشانگر؛ نمونه‌برداری متوقف شد.');
    sequence = sequence * 2 + Number(value > (dark + light) / 2);
  }
  return sequence;
}
export function sampleMarker(image: PixelImage, roi: Rect, options?: { purpose: 'analysisGeometry' }): number[][] {
  const analysis = options?.purpose === 'analysisGeometry';
  if (![roi.x, roi.y, roi.width, roi.height].every(Number.isFinite) || roi.width < (analysis ? 56 : 112) || roi.height < (analysis ? 2 : 4) || roi.x < 0 || roi.y < 0 || roi.x + roi.width > image.width || roi.y + roi.height > image.height) throw new Error('ROI نشانگر باید داخل تصویر و دارای وضوح کافی باشد.');
  const scale = image.data instanceof Uint8ClampedArray ? 255 : 1;
  const cells = Array.from({ length: 28 }, (_, cell) => {
    const rgb = [0, 0, 0]; let count = 0;
    const left = roi.x + (cell + 0.3) * roi.width / 28;
    const right = roi.x + (cell + 0.7) * roi.width / 28;
    for (let y = Math.ceil(roi.y + roi.height * (analysis ? .2 : .3)); y < roi.y + roi.height * (analysis ? .8 : .7); y++) for (let x = Math.ceil(left); x < right; x++) {
      const i = (y * image.width + x) * 4;
      for (let c = 0; c < 3; c++) rgb[c] += Number(image.data[i + c]) / scale;
      count++;
    }
    if (!count) throw new Error('خانهٔ نشانگر بدون پیکسل است.');
    return rgb.map(v => v / count);
  });
  if (analysis) {
    const sequence = decodeMarker(cells);
    let rows = 0;
    for (let y = Math.ceil(roi.y + roi.height * .2); y < roi.y + roi.height * .8; y++) {
      const row = Array.from({ length: 28 }, (_, cell) => {
        const rgb = [0, 0, 0]; let count = 0;
        for (let x = Math.ceil(roi.x + (cell + .3) * roi.width / 28); x < roi.x + (cell + .7) * roi.width / 28; x++) {
          const i = (y * image.width + x) * 4;
          for (let c = 0; c < 3; c++) rgb[c] += Number(image.data[i + c]) / scale;
          count++;
        }
        return rgb.map(value => value / count);
      });
      if (decodeMarker(row) !== sequence) throw new Error('نشانگر در ردیف‌های تصویر یکسان نیست.');
      rows++;
    }
    if (rows < 2) throw new Error('نشانگر باید دست‌کم دو ردیف مستقل داشته باشد.');
  }
  return cells;
}
