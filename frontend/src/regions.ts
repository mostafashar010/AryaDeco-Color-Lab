import { bounds, type Point, type Region } from './sampling';
export function newRegion(polygon: Point[], order: number): Region {
  return { id: crypto.randomUUID(), label: `نمونه ${order}`, order, mode: 'solid', polygon, exclusions: [], background: null, layers: null, direction: null, operatorConfirmed: false };
}
export function appendExclusion(exclusions: Point[][], polygon: Point[]) {
  if (exclusions.length >= 32) throw new Error('سقف ۳۲ ماسک حذف رسید؛ ماسک‌ها را پاک یا با رأس‌ها ویرایش کنید.');
  return [...exclusions, polygon];
}
export function splitRegion(region: Region, orientation: 'horizontal' | 'vertical', coordinate: number): Region[] {
  const axis = orientation === 'vertical' ? 0 : 1;
  const b = bounds(region.polygon);
  if (!Number.isFinite(coordinate) || coordinate <= (axis ? b.y : b.x) || coordinate >= (axis ? b.y + b.height : b.x + b.width)) throw new Error('خط تقسیم باید داخل ناحیه باشد.');
  const clip = (left: boolean) => {
    const out: Point[] = [];
    for (let i = 0; i < region.polygon.length; i++) {
      const a = region.polygon[i], c = region.polygon[(i + 1) % region.polygon.length];
      const inside = left ? a[axis] <= coordinate : a[axis] >= coordinate;
      const nextInside = left ? c[axis] <= coordinate : c[axis] >= coordinate;
      if (inside) out.push(a);
      if (inside !== nextInside) { const t = (coordinate - a[axis]) / (c[axis] - a[axis]); out.push([a[0] + t * (c[0] - a[0]), a[1] + t * (c[1] - a[1])]); }
    }
    return out;
  };
  return [true, false].map((left, i) => ({ ...region, id: crypto.randomUUID(), label: `${region.label} / ${i + 1}`, order: region.order + i, polygon: clip(left), operatorConfirmed: false }));
}
export function mergeRegions(a: Region, b: Region): Region {
  const x = bounds(a.polygon), y = bounds(b.polygon);
  const rectangular = (r: Region, box: typeof x) => r.polygon.length === 4 && r.polygon.every(p => (p[0] === box.x || p[0] === box.x + box.width) && (p[1] === box.y || p[1] === box.y + box.height));
  const adjacent = (x.y === y.y && x.height === y.height && (x.x + x.width === y.x || y.x + y.width === x.x)) || (x.x === y.x && x.width === y.width && (x.y + x.height === y.y || y.y + y.height === x.y));
  if (!rectangular(a, x) || !rectangular(b, y) || !adjacent) throw new Error('ادغام فقط برای مستطیل‌های هم‌مرز انجام می‌شود؛ برای شکل دیگر چندضلعی را ویرایش کنید.');
  if (a.exclusions.length + b.exclusions.length > 32) throw new Error('ادغام از سقف ۳۲ ماسک حذف عبور می‌کند.');
  const left = Math.min(x.x, y.x), top = Math.min(x.y, y.y), right = Math.max(x.x + x.width, y.x + y.width), bottom = Math.max(x.y + x.height, y.y + y.height);
  return { ...a, id: crypto.randomUUID(), label: `${a.label} + ${b.label}`, order: Math.min(a.order, b.order), polygon: [[left, top], [right, top], [right, bottom], [left, bottom]], exclusions: [...a.exclusions, ...b.exclusions], operatorConfirmed: false };
}
