import type { PixelImage } from './marker';
import { contains, bounds, type Point, type Region } from './sampling';

export function suggestLiveBands(image: PixelImage, source: Region, offset = { x: 0, y: 0 }, orientation: 'horizontal' | 'vertical' = 'horizontal') {
  if (image.width < 8 || image.height < 8 || image.width * image.height > 2_000_000 || image.data.length !== image.width * image.height * 4) throw new Error('تصویر کوچکِ زنده برای پیشنهاد نوارها آماده نیست.');
  const vertical = orientation === 'vertical';
  const length = vertical ? image.width : image.height, cross = vertical ? image.height : image.width;
  const scale = image.data instanceof Uint8ClampedArray ? 255 : 1;
  for (let i=0;i<image.data.length;i+=4) {
    if (Number(image.data[i+3])/scale < .99 || [0,1,2,3].some(c => !Number.isFinite(Number(image.data[i+c])) || Number(image.data[i+c]) < 0 || Number(image.data[i+c])/scale > 1)) throw new Error('پیکسل نامعتبر یا شفاف؛ نوارهای پارچه قابل تشخیص نیستند.');
  }
  const rows: number[][] = [];
  const median = (values: number[]) => { values.sort((a,b) => a-b); return values[Math.floor(values.length / 2)]; };
  for (let line = 0; line < length; line++) {
    const channels: number[][] = [[], [], []];
    for (let across = 0; across < cross; across += Math.max(1, Math.floor(cross / 64))) {
      const x = vertical ? line : across, y = vertical ? across : line;
      const point: Point = [x + offset.x + 0.5, y + offset.y + 0.5];
      if (!contains(point, source.polygon) || source.exclusions.some(p => contains(point, p))) continue;
      const index = (y * image.width + x) * 4;
      for (let c = 0; c < 3; c++) channels[c].push(Number(image.data[index + c]) / scale);
    }
    rows.push(channels[0].length ? channels.map(median) : [NaN, NaN, NaN]);
  }
  const window = Math.max(2, Math.floor(length / 100));
  const scores = Array(length).fill(0) as number[];
  for (let line = window; line < length - window; line++) {
    const before = [0, 1, 2].map(c => median(rows.slice(line-window, line).map(r => r[c]).filter(Number.isFinite)));
    const after = [0, 1, 2].map(c => median(rows.slice(line, line+window).map(r => r[c]).filter(Number.isFinite)));
    const score = Math.hypot(...before.map((n,c) => after[c]-n));
    const adjacent = Math.hypot(...rows[line].map((n,c) => n-rows[line-1][c]));
    const neighboring = [line-2,line-1,line+1,line+2].filter(i => i>0 && i<length).map(i => Math.hypot(...rows[i].map((n,c) => n-rows[i-1][c]))).filter(Number.isFinite);
    const floor = neighboring.length ? Math.max(...neighboring) : 0;
    scores[line] = Number.isFinite(score) && Number.isFinite(adjacent) && adjacent >= score*.65 && adjacent > floor*2 + .005 ? score : 0;
  }
  // Geometry only: a conservative edge threshold, not a color-accuracy criterion.
  const minimumSeparation = Math.max(8, Math.floor(length / 40));
  const candidates = scores.map((score, index) => ({ score, index })).filter(v => v.score > 0.018).sort((a,b) => b.score-a.score);
  const edges: number[] = [];
  for (const candidate of candidates) {
    if (edges.length >= 30) break;
    if (candidate.index >= minimumSeparation && length-candidate.index >= minimumSeparation && edges.every(edge => Math.abs(edge-candidate.index) >= minimumSeparation)) edges.push(candidate.index);
  }
  const boundaries = [0, ...edges.sort((a,b) => a-b), length];
  const b = bounds(source.polygon);
  const regions: Region[] = [];
  for (let i=0; i<boundaries.length-1; i++) {
    const margin = Math.min(3, Math.floor((boundaries[i+1]-boundaries[i])/8));
    const low = boundaries[i] + margin, high = boundaries[i+1] - margin;
    const x0 = vertical ? low + offset.x : b.x, x1 = vertical ? high + offset.x : b.x+b.width;
    const y0 = vertical ? b.y : low + offset.y, y1 = vertical ? b.y+b.height : high + offset.y;
    let polygon = source.polygon;
    for (const [axis, boundary, keepAbove] of [[0,x0,true],[0,x1,false],[1,y0,true],[1,y1,false]] as [number,number,boolean][]) {
      const clipped: Point[] = [];
      for (let index=0; index<polygon.length; index++) {
        const a = polygon[index], b = polygon[(index+1)%polygon.length];
        const insideA = keepAbove ? a[axis]>=boundary : a[axis]<=boundary;
        const insideB = keepAbove ? b[axis]>=boundary : b[axis]<=boundary;
        if (insideA) clipped.push(a);
        if (insideA !== insideB) {
          const t = (boundary-a[axis])/(b[axis]-a[axis]);
          clipped.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);
        }
      }
      polygon = clipped;
    }
    if (polygon.length >= 3) regions.push({ ...source, id: `${source.id}-proposal-${i+1}`, label: `نمونه ${i+1}`, order: source.order+i, mode: 'bands', polygon, exclusions: source.exclusions, operatorConfirmed: false });
  }
  return { regions, method: 'singleFrameGeometryProposalNotMeasurement' as const, warning: 'مرزها پیشنهادی‌اند؛ متر، چین، حاشیه و نوارهای نزدیک را بررسی و فقط یک‌بار تأیید کنید. این فریم اندازه‌گیری رنگ نیست.' };
}

export async function suggestLiveRegions(video: HTMLVideoElement, source: Region): Promise<Region[]> {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) throw new Error('دوربین زنده هنوز فریم آماده ندارد.');
  const b = bounds(source.polygon);
  if (b.x+b.width > video.videoWidth || b.y+b.height > video.videoHeight || b.width < 16 || b.height < 16) throw new Error('قاب پارچه باید داخل تصویر زنده و به‌اندازهٔ کافی بزرگ باشد.');
  const factor = Math.min(1, 512/Math.max(b.width,b.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(8,Math.round(b.width*factor)); canvas.height = Math.max(8,Math.round(b.height*factor));
  const sx = canvas.width/b.width, sy = canvas.height/b.height;
  const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  if (!context) throw new Error('پیشنهاد هندسهٔ زنده در این مرورگر در دسترس نیست.');
  context.drawImage(video,b.x,b.y,b.width,b.height,0,0,canvas.width,canvas.height);
  const map = (points: Point[]): Point[] => points.map(([x,y]) => [(x-b.x)*sx,(y-b.y)*sy]);
  const sourceScaled = { ...source, polygon: map(source.polygon), exclusions: source.exclusions.map(map) };
  const image = context.getImageData(0,0,canvas.width,canvas.height);
  const proposed = suggestLiveBands(image,sourceScaled);
  const unmap = (points: Point[]): Point[] => points.map(([x,y]) => [x/sx+b.x,y/sy+b.y]);
  return proposed.regions.map(region => ({ ...region, polygon: unmap(region.polygon), exclusions: source.exclusions, operatorConfirmed: false }));
}
