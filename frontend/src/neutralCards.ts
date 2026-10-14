import type { PixelImage } from './marker';
import { contains, type Point, type Region } from './sampling';

export type NeutralCards = {
  status: 'ready' | 'needsFraming' | 'ambiguous';
  cards: { role: 'dark' | 'middle' | 'light'; region: Region; observedRgb: [number, number, number]; confidence: number }[];
  nextAction: string;
  evidence: { referenceValues: 'unknown'; physicalStandardVerified: false; method: 'boundedColorComponentsOrientedGeometry'; candidateCount: number; analysisWidth: number; analysisHeight: number; limitations: string[]; rejections?: Record<string,number>; candidateGeometry?: { polygon:Point[]; label:string; observedBrightness:number }[]; matchingTriplets?:number; reason?:string };
};

// Color distance keeps lighting casts instead of projecting pixels onto a gray axis.
function distance(r: number, g: number, bl: number, b: number[]) {
  r -= b[0]; g -= b[1]; bl -= b[2];
  const mean = (r + g + bl) / 3;
  return r * r + g * g + bl * bl + 3 * ((r - mean) ** 2 + (g - mean) ** 2 + (bl - mean) ** 2);
}

export function detectNeutralCards(image: PixelImage): NeutralCards {
  const result: NeutralCards = { status: 'needsFraming', cards: [], nextAction: 'سه کارت تیره، میانی و روشن را جدا، کامل و بدون بازتاب در قاب بگذارید.', evidence: { referenceValues: 'unknown', physicalStandardVerified: false, method: 'boundedColorComponentsOrientedGeometry', candidateCount: 0, analysisWidth: 0, analysisHeight: 0, limitations: ['Only observed brightness roles and AI geometry; unknown physical identity and reference values.', 'Three neutral candidates cannot determine a full RGB calibration matrix.'] } };
  result.evidence.rejections={};result.evidence.candidateGeometry=[];
  const reject=(reason:string)=>{const counts=result.evidence.rejections!;counts[reason]=(counts[reason]??0)+1;};
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 32 || image.height < 32 || image.width * image.height > 16_000_000 || image.data.length !== image.width * image.height * 4) {result.evidence.reason='invalidFrame';return result;}
  const factor = Math.min(1, 320 / Math.max(image.width, image.height));
  const w = Math.floor(image.width * factor), h = Math.floor(image.height * factor), sx = image.width / w, sy = image.height / h;
  result.evidence.analysisWidth = w; result.evidence.analysisHeight = h;
  const scale = image.data instanceof Uint8ClampedArray ? 255 : 1;
  // Float64 preserves the original byte/float arithmetic and threshold comparisons.
  const colors = new Float64Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (Math.floor(y * sy) * image.width + Math.floor(x * sx)) * 4;
    for (let c = 0; c < 3; c++) {
      const value = Number(image.data[i + c]) / scale;
      if (!Number.isFinite(value) || value < 0 || value > 1) {result.evidence.reason='invalidPixels';return result;}
      colors[(y * w + x) * 3 + c] = value;
    }
    if (Number(image.data[i + 3]) / scale < 0.99) {result.evidence.reason='invalidPixels';return result;}
  }
  const middle = Math.floor(w * h / 2) * 3;
  const centers = [[colors[middle], colors[middle + 1], colors[middle + 2]]];
  while (centers.length < 8) {
    let farthest = 0, best = 0;
    for (let i = 0; i < colors.length; i += 51) {
      let d = Infinity;
      for (const center of centers) d = Math.min(d, distance(colors[i], colors[i + 1], colors[i + 2], center));
      if (d > best) { best = d; farthest = i; }
    }
    if (best < 0.001) break;
    centers.push([colors[farthest], colors[farthest + 1], colors[farthest + 2]]);
  }
  for (let iteration = 0; iteration < 8; iteration++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let p = 0; p < colors.length; p += 51) {
      let index = 0, best = Infinity;
      for (let i = 0; i < centers.length; i++) { const d = distance(colors[p], colors[p + 1], colors[p + 2], centers[i]); if (d < best) { index = i; best = d; } }
      for (let c = 0; c < 3; c++) sums[index][c] += colors[p + c]; sums[index][3]++;
    }
    sums.forEach((sum, i) => { if (sum[3]) centers[i] = sum.slice(0, 3).map(v => v / sum[3]); });
  }
  type Candidate = { polygon: Point[]; center: Point; area: number; aspect: number; color: number[]; confidence: number };
  const candidates: Candidate[] = [];
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const queue = new Int32Array(w * h);
  const distances = new Float64Array(w * h);
  for (const center of centers) {
    for (let i = 0; i < distances.length; i++) distances[i] = distance(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2], center);
    for (const tolerance of [0.12, 0.18, 0.24]) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) if (distances[i] < tolerance ** 2) mask[i] = 1;
    for (let start = 0; start < mask.length; start++) {
      if (mask[start] !== 1) continue;
      let head = 0, tail = 1; queue[0] = start; mask[start] = 2;
      let clipped = false;
      const boundary: Point[] = [];
      while (head < tail) {
        const i = queue[head++], x = i % w, y = Math.floor(i / w);
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) clipped = true;
        let edge = false;
        for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
          if (n < 0 || mask[n] === 0) { edge = true; continue; }
          if (mask[n] === 1) { mask[n] = 2; queue[tail++] = n; }
        }
        if (edge) boundary.push([x + 0.5, y + 0.5]);
      }
      if (clipped || tail < w * h * 0.008 || tail > w * h * 0.3) {reject(clipped?'touchesFrameEdge':tail<w*h*.008?'tooSmall':'tooLarge');continue;}
      boundary.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const lower: Point[] = [], upper: Point[] = [];
      for (const p of boundary) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
      for (const p of boundary.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
      const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
      let fit: { area: number; u: Point; v: Point; minU: number; maxU: number; minV: number; maxV: number } | undefined;
      for (let j = 0; j < hull.length; j++) {
        const a = hull[j], b = hull[(j + 1) % hull.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const u: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length], v: Point = [-u[1], u[0]];
        const us = hull.map(p => p[0] * u[0] + p[1] * u[1]), vs = hull.map(p => p[0] * v[0] + p[1] * v[1]);
        const minU = Math.min(...us), maxU = Math.max(...us), minV = Math.min(...vs), maxV = Math.max(...vs), area = (maxU - minU) * (maxV - minV);
        if (!fit || area < fit.area) fit = { area, u, v, minU, maxU, minV, maxV };
      }
      if (!fit || tail / fit.area < 0.86) {reject('nonRectangularOrOccluded');continue;}
      const du = fit.maxU - fit.minU, dv = fit.maxV - fit.minV, aspect = Math.max(du, dv) / Math.min(du, dv);
      if (aspect < 1.25 || aspect > 2.05 || Math.min(du, dv) < 18) {reject('shapeOrSize');continue;}
      const point = (u: number, v: number): Point => [u * fit!.u[0] + v * fit!.v[0], u * fit!.u[1] + v * fit!.v[1]];
      const inset = 0.15;
      const polygon = [point(fit.minU + du * inset, fit.minV + dv * inset), point(fit.maxU - du * inset, fit.minV + dv * inset), point(fit.maxU - du * inset, fit.maxV - dv * inset), point(fit.minU + du * inset, fit.maxV - dv * inset)];
      const sum = [0, 0, 0], squares = [0, 0, 0]; let count = 0, misses = 0;
      const minX = Math.floor(Math.min(...polygon.map(p => p[0]))), maxX = Math.ceil(Math.max(...polygon.map(p => p[0])));
      const minY = Math.floor(Math.min(...polygon.map(p => p[1]))), maxY = Math.ceil(Math.max(...polygon.map(p => p[1])));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (contains([x + 0.5, y + 0.5], polygon)) {
        const index = y * w + x;
        if (distances[index] >= tolerance ** 2) misses++;
        for (let c = 0; c < 3; c++) { const value = colors[index * 3 + c]; sum[c] += value; squares[c] += value ** 2; } count++;
      }
      if (!count || misses / count > 0.005 || squares.some((v, c) => Math.sqrt(Math.max(0, v / count - (sum[c] / count) ** 2)) > 0.055)) {reject('nonuniformInteriorOrGlare');continue;}
      const location = point((fit.minU + fit.maxU) / 2, (fit.minV + fit.maxV) / 2);
      const confidence = Math.min(0.95, tail / fit.area);
      const candidate: Candidate = { polygon, center: location, area: fit.area, aspect, color: sum.map(v => v / count), confidence };
      const existing = candidates.findIndex(c => Math.hypot(c.center[0] - location[0], c.center[1] - location[1]) < Math.sqrt(Math.min(c.area, fit!.area)) * 0.2);
      if (existing < 0) candidates.push(candidate);
      else if (candidate.area > candidates[existing].area) candidates[existing] = candidate;
    }
  }
  }
  result.evidence.candidateCount = candidates.length;
  const brightness = (c: Candidate) => c.color[0] * 0.2126 + c.color[1] * 0.7152 + c.color[2] * 0.0722;
  result.evidence.candidateGeometry=candidates.slice(0,12).map((candidate,index)=>({polygon:candidate.polygon.map(([x,y])=>[x*sx,y*sy] as Point),label:`سطح پیشنهادی ${index+1}؛ هنوز کارت تأیید نشده`,observedBrightness:brightness(candidate)}));
  candidates.sort((a, b) => brightness(a) - brightness(b));
  const triples: Candidate[][] = [];
  for (let a = 0; a < candidates.length; a++) for (let b = a + 1; b < candidates.length; b++) for (let c = b + 1; c < candidates.length; c++) {
    const group = [candidates[a], candidates[b], candidates[c]];
    if (brightness(group[1]) - brightness(group[0]) < 0.12 || brightness(group[2]) - brightness(group[1]) < 0.12) continue;
    if (Math.max(...group.map(v => v.area)) / Math.min(...group.map(v => v.area)) > 1.8 || Math.max(...group.map(v => v.aspect)) - Math.min(...group.map(v => v.aspect)) > 0.3) continue;
    const chromas = group.map(v => { const mean = v.color.reduce((s, n) => s + n, 0) / 3; return v.color.map(n => n - mean); });
    if (chromas.some(v => chromas.some(u => Math.hypot(...v.map((n, i) => n - u[i])) > 0.13))) continue;
    if (group.some((v, i) => group.slice(i + 1).some(u => contains(v.center, u.polygon) || contains(u.center, v.polygon)))) continue;
    triples.push(group);
  }
  if (triples.length !== 1) {
    result.evidence.matchingTriplets=triples.length;
    result.evidence.reason=triples.length>1?'multipleCardSets':candidates.length<3?'missingCardCandidates':'cardSetGeometryOrBrightnessMismatch';
    if(candidates.length<3) result.nextAction=`${new Intl.NumberFormat('fa-IR').format(candidates.length)} سطح شبیه کارت دیده شد؛ سه کارت را بزرگ‌تر، جدا و با همهٔ لبه‌ها داخل قاب بگذارید. گوشی و کالیته را فعلاً کنار قاب کارت‌ها بگذارید.`;
    else if(!triples.length) result.nextAction='سطح‌های شبیه کارت دیده شد اما مجموعهٔ تیره، میانی و روشن مشخص نیست؛ فقط سه کارت را کنار هم، بدون بازتاب و بدون هم‌پوشانی در قاب بگذارید.';
    if (triples.length > 1 || candidates.length > 3) { result.status = 'ambiguous'; result.nextAction = 'چند مجموعهٔ مشابه دیده می‌شود؛ فقط سه کارت موردنظر را جدا در قاب نگه دارید.'; }
    return result;
  }
  result.cards = triples[0].map((candidate, index) => {
    const role = (['dark', 'middle', 'light'] as const)[index];
    const polygon = candidate.polygon.map(([x, y]) => [x * sx, y * sy] as Point);
    const region: Region = { id: `auto-neutral-${role}`, label: `Observed ${role} card; reference values unknown`, order: index, mode: 'solid', polygon, exclusions: [], background: null, layers: null, direction: null, operatorConfirmed: false, selectionMethod: 'autoDetected' };
    const mean = [0, 0, 0]; let count = 0;
    const minX = Math.floor(Math.min(...polygon.map(p => p[0]))), maxX = Math.ceil(Math.max(...polygon.map(p => p[0])));
    const minY = Math.floor(Math.min(...polygon.map(p => p[1]))), maxY = Math.ceil(Math.max(...polygon.map(p => p[1])));
    for (let y = minY; y < maxY; y++) for (let x = minX; x < maxX; x++) if (contains([x + 0.5, y + 0.5], polygon)) {
      const i = (y * image.width + x) * 4;
      for (let c = 0; c < 3; c++) mean[c] += Number(image.data[i + c]) / scale; count++;
    }
    return { role, region, observedRgb: mean.map(v => v / count) as [number, number, number], confidence: candidate.confidence };
  });
  result.status = 'ready'; result.nextAction = 'سه سطح کارت پیدا شد؛ قاب را ثابت نگه دارید. رنگ و استاندارد فیزیکی کارت‌ها هنوز نامعلوم است.';
  result.evidence.matchingTriplets=1;result.evidence.reason='threeCardCandidates';
  return result;
}
