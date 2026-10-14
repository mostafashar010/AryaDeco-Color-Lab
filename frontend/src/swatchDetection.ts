import type { PixelImage } from './marker';
import { contains, type Point, type Region } from './sampling';

export type SwatchRegion = Region & { source: 'autoDetected'; confidence: number; geometryStatus: 'candidate' | 'full'; clipped: boolean };
export type SwatchLayout = {
  status: 'ready' | 'needsFraming' | 'ambiguous';
  fabricRegions: SwatchRegion[];
  evidence: { geometryOnly: true; analysisWidth: number; analysisHeight: number; horizontalEdges: number; reason: string; limitations: string[] };
};

// Coordinates and exclusions are native image pixels, never physical color evidence.
export function detectSwatchLayout(image: PixelImage, exclusions: Point[][] = []): SwatchLayout {
  const result: SwatchLayout = { status: 'needsFraming', fabricRegions: [], evidence: { geometryOnly: true, analysisWidth: 0, analysisHeight: 0, horizontalEdges: 0, reason: 'insufficientBandGeometry', limitations: ['AI geometry only; material, physical colors and hidden edges are unknown.', 'Frame-touching bands remain clipped candidates; exclusions are not operator-confirmed.'] } };
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 32 || image.height < 32 || image.width * image.height > 16_000_000 || image.data.length !== image.width * image.height * 4) { result.evidence.reason = 'invalidFrame'; return result; }
  if (exclusions.length > 32 || exclusions.some(p => p.length < 3 || p.length > 64 || p.some(v => v.length !== 2 || v.some(n => !Number.isFinite(n) || n < 0)))) { result.evidence.reason = 'invalidExclusions'; return result; }
  const factor = Math.min(1, 640 / Math.max(image.width, image.height));
  const w = Math.floor(image.width * factor), h = Math.floor(image.height * factor), sx = image.width / w, sy = image.height / h;
  result.evidence.analysisWidth = w; result.evidence.analysisHeight = h;
  const scale = image.data instanceof Uint8ClampedArray ? 255 : 1;
  const grid = new Float32Array(w * h * 3), mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const source = (Math.floor(y * sy) * image.width + Math.floor(x * sx)) * 4, index = y * w + x;
    const alpha = Number(image.data[source + 3]) / scale;
    if (!Number.isFinite(alpha) || alpha < 0.99) { result.evidence.reason = 'invalidPixels'; return result; }
    for (let c = 0; c < 3; c++) {
      const value = Number(image.data[source + c]) / scale;
      if (!Number.isFinite(value) || value < 0 || value > 1) { result.evidence.reason = 'invalidPixels'; return result; }
      grid[index * 3 + c] = value;
    }
  }
  // Rasterize the union only where a polygon can contain an analysis-pixel center.
  for (const polygon of exclusions) {
    const left = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[0])) / sx - 0.5));
    const right = Math.min(w - 1, Math.ceil(Math.max(...polygon.map(p => p[0])) / sx - 0.5));
    const top = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[1])) / sy - 0.5));
    const bottom = Math.min(h - 1, Math.ceil(Math.max(...polygon.map(p => p[1])) / sy - 0.5));
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const index = y * w + x;
      if (!mask[index] && contains([(x + 0.5) * sx, (y + 0.5) * sy], polygon)) mask[index] = 1;
    }
  }
   const median = (values: number[]) => {
     for (let i = 1; i < values.length; i++) { const v = values[i]; let j = i; while (j > 0 && values[j - 1] > v) { values[j] = values[j - 1]; j--; } values[j] = v; }
     return values[Math.floor(values.length / 2)];
   };
   const distance = (a: number[], b: number[]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
   const localObjects: Point[][] = [];
   const tile = 12;
   let activeObjects: { left: number; right: number; top: number; bottom: number }[] = [];
   const objectBoxes: typeof activeObjects = [];
   let previousConsensus: number[] | undefined, consensusTransitions = 0;
   for (let y = 0; y < h; y += tile) {
     const samples: { x: number; rgb: number[] }[] = [];
     for (let x = 0; x < w; x += tile) {
       const values: number[][] = [[], [], []];
       for (let yy = y + 2; yy < Math.min(h, y + tile); yy += 3) for (let xx = x + 2; xx < Math.min(w, x + tile); xx += 3) {
         if (mask[yy * w + xx]) continue;
         for (let c = 0; c < 3; c++) values[c].push(grid[(yy * w + xx) * 3 + c]);
       }
       if (values[0].length >= 4) samples.push({ x, rgb: values.map(median) });
     }
     const consensus = [0, 1, 2].map(c => median(samples.map(v => v.rgb[c])));
     const agrees = samples.filter(v => distance(v.rgb, consensus) < 0.065).length;
     if (agrees >= samples.length * 0.55 && distance(samples[0]?.rgb ?? [], samples.at(-1)?.rgb ?? []) < 0.08) {
       if (previousConsensus && distance(previousConsensus, consensus) > 0.014) consensusTransitions++;
       previousConsensus = consensus;
     }
     const current: typeof activeObjects = [];
     if (samples.length && agrees >= samples.length * 0.55) for (let i = 0; i < samples.length; i++) {
       if (distance(samples[i].rgb, consensus) < 0.14) continue;
       const left = samples[i].x;
       let right = Math.min(w, left + tile);
       while (i + 1 < samples.length && samples[i + 1].x === right && distance(samples[i + 1].rgb, consensus) >= 0.14) right = Math.min(w, samples[++i].x + tile);
       // Broad changes may be fabric geometry, not local occluders.
       if (right - left > w * 0.45 || right - left < tile * 2) continue;
       const previous = activeObjects.find(p => p.left === left && p.right === right);
       const box = previous ?? { left, right, top: y, bottom: y };
       box.bottom = Math.min(h, y + tile); current.push(box);
     }
     objectBoxes.push(...activeObjects.filter(p => !current.includes(p)));
     activeObjects = current;
   }
   objectBoxes.push(...activeObjects);
   for (const box of objectBoxes) if (consensusTransitions >= 5 && box.bottom - box.top >= tile && localObjects.length + exclusions.length < 32) {
     localObjects.push([[box.left * sx, box.top * sy], [box.right * sx, box.top * sy], [box.right * sx, box.bottom * sy], [box.left * sx, box.bottom * sy]]);
     for (let yy = box.top; yy < box.bottom; yy++) mask.fill(1, yy * w + box.left, yy * w + box.right);
   }
  const filtered = new Float32Array(grid.length), filteredState = new Uint8Array(mask.length);
  const channels = [new Float32Array(15), new Float32Array(15), new Float32Array(15)];
  const color = (x: number, y: number) => {
    const index = y * w + x;
    if (filteredState[index]) return filteredState[index] === 1 ? [filtered[index * 3], filtered[index * 3 + 1], filtered[index * 3 + 2]] : undefined;
    let count = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 1; dy++) {
      const xx = Math.max(0, Math.min(w - 1, x + dx)), yy = Math.max(0, Math.min(h - 1, y + dy));
      if (mask[yy * w + xx]) continue;
      for (let c = 0; c < 3; c++) channels[c][count] = grid[(yy * w + xx) * 3 + c];
      count++;
    }
    filteredState[index] = count ? 1 : 2;
    if (!count) return undefined;
    // Exact upper median, including repeated clamped edge pixels and masked neighbors.
    for (let c = 0; c < 3; c++) {
      const values = channels[c];
      for (let i = 1; i < count; i++) {
        const value = values[i]; let j = i;
        while (j > 0 && values[j - 1] > value) { values[j] = values[j - 1]; j--; }
        values[j] = value;
      }
      filtered[index * 3 + c] = values[Math.floor(count / 2)];
    }
    return [filtered[index * 3], filtered[index * 3 + 1], filtered[index * 3 + 2]];
  };
   type Edge = { y: number; left: number; right: number; support: number; strength: number };
   const edges: Edge[] = [];
  for (let y = 3; y < h - 3; y++) {
     const positions: number[] = [], strengths: number[] = [];
     const signs = new Int32Array(6);
     for (let x = 2; x < w - 2; x += 3) {
       const yy = y;
       if (mask[(yy - 3) * w + x] || mask[(yy + 3) * w + x]) continue;
       const above = color(x, yy - 3), below = color(x, yy + 3);
      if (!above || !below) continue;
       const d = distance(above, below);
       if (d >= 0.014) {
         // Thin bright ridges (including screenshot preview outlines) are not
         // persistent material boundaries when both beyond-ridge interiors agree.
         let ridge = false;
         for (let offset = -3; offset <= 3; offset++) {
           const row = yy + offset, center = color(x, row);
           const a = color(x, Math.max(0, row - 5)), b = color(x, Math.min(h - 1, row + 5));
           if (a && b && center && distance(a, b) < 0.06 && Math.min(...center.map((v, c) => v - Math.max(a[c], b[c]))) > 0.12) { ridge = true; break; }
         }
         if (ridge) continue;
         const nearAbove = color(x, yy - 2), nearBelow = color(x, yy + 2);
         const farAbove = color(x, Math.max(0, yy - 8)), farBelow = color(x, Math.min(h - 1, yy + 8));
         if (!nearAbove || !nearBelow || !farAbove || !farBelow || distance(nearAbove, nearBelow) < distance(farAbove, farBelow) * 0.55 || distance(farAbove, farBelow) < d * 0.45) continue;
         let channel = 0;
         for (let c = 1; c < 3; c++) if (Math.abs(below[c] - above[c]) > Math.abs(below[channel] - above[channel])) channel = c;
         signs[channel * 2 + Number(below[channel] > above[channel])]++;
        positions.push(x); strengths.push(d);
      }
    }
     if (positions.length * 3 < w * 0.2) continue;
     // Mesh/texture oscillations disagree across columns; physical long edges agree.
     if (Math.max(signs[0] + signs[2] + signs[4], signs[1] + signs[3] + signs[5]) < positions.length * 0.7) continue;
    // Isolated texture edges cannot vote for a long horizontal boundary.
    let longest = 0, start = 0;
    for (let i = 1; i <= positions.length; i++) {
      if (i < positions.length && positions[i] - positions[i - 1] <= 9) continue;
      longest = Math.max(longest, positions[i - 1] - positions[start] + 3); start = i;
    }
    if (longest < w * 0.12) continue;
    const edge = { y, left: Math.max(0, positions[0] - 3), right: Math.min(w, positions.at(-1)! + 3), support: positions.length * 3, strength: median(strengths) };
    const previous = edges.at(-1);
    if (previous && y - previous.y <= 6 && Math.min(previous.right, edge.right) - Math.max(previous.left, edge.left) > Math.min(previous.right - previous.left, edge.right - edge.left) * 0.7) {
      if (edge.support * edge.strength > previous.support * previous.strength) edges[edges.length - 1] = edge;
    } else edges.push(edge);
  }
   // A fold has two opposite edges and returns to the same interior. Color proximity
   // alone never removes a single boundary between two physical swatches.
   const persistent: Edge[] = [];
   let uncertainBoundary = false;
   for (let i = 0; i < edges.length; i++) {
     const a = edges[i], b = edges[i + 1];
     let continuing = 0, tested = 0;
     const beforeRows: number[][] = [[], [], []], afterRows: number[][] = [[], [], []], ridgeRows: number[][] = [[], [], []];
     for (let x = 2; x < w - 2; x += 9) {
       const before = [8, 10, 12, 14, 16, 18, 20].map(d => color(x, Math.max(0, a.y - d))).filter((v): v is number[] => !!v);
       const after = [8, 10, 12, 14, 16, 18, 20].map(d => color(x, Math.min(h - 1, a.y + d))).filter((v): v is number[] => !!v);
       if (before.length < 3 || after.length < 3) continue;
       const av = [0, 1, 2].map(c => { const v = before.map(v => v[c]); median(v); return v[Math.floor(v.length * 0.25)]; }), bv = [0, 1, 2].map(c => { const v = after.map(v => v[c]); median(v); return v[Math.floor(v.length * 0.25)]; });
       tested++;
        const ridgeOffsets=Array.from({length:13},(_,i)=>i-6);
        const ridge = ridgeOffsets.map(d => color(x, Math.max(0,Math.min(h-1,a.y + d)))).filter((v): v is number[] => !!v).some(center => Math.min(...center.map((v, c) => v - Math.max(av[c], bv[c]))) > 0.055);
       for (let c = 0; c < 3; c++) {
         beforeRows[c].push(av[c]); afterRows[c].push(bv[c]);
          ridgeRows[c].push(Math.max(...ridgeOffsets.map(d => color(x, Math.max(0,Math.min(h-1,a.y + d)))?.[c] ?? 0)));
       }
       if (ridge && distance(av, bv) < 0.04) continuing++;
     }
      const av = beforeRows.map(median), bv = afterRows.map(median), peak = ridgeRows.map(median);
      const chromaticity=(rgb:number[])=>rgb.map(v=>v/Math.max(.01,rgb.reduce((a,b)=>a+b,0)));
      if (tested >= w / 9 * 0.5 && distance(av, bv) < 0.06 && distance(chromaticity(av),chromaticity(bv))<.025 && Math.min(...peak.map((v, c) => v - Math.max(av[c], bv[c]))) > 0.06) { uncertainBoundary = true; continue; }
     if (a.support >= w * 0.4 && tested >= w / 9 * 0.5 && a.strength < 0.04 && distance(av, bv) < 0.018) continue;
     if (continuing >= w / 9 * 0.35 && continuing >= tested * 0.65) continue;
     if (b && b.y - a.y >= 6 && b.y - a.y <= Math.max(24, h * 0.12)) {
       let votes = 0, visible = 0;
       for (let x = 2; x < w - 2; x += 6) {
         const before = color(x, Math.max(0, a.y - 8)), after = color(x, Math.min(h - 1, b.y + 8));
         const trough = color(x, Math.floor((a.y + b.y) / 2));
         if (!before || !after || !trough || mask[Math.max(0, a.y - 8) * w + x] || mask[Math.min(h - 1, b.y + 8) * w + x]) continue;
         visible++;
         const drops = before.map((v, c) => v - trough[c]);
         const chroma = (v: number[]) => { const sum = v[0] + v[1] + v[2]; return v.map(c => c / Math.max(0.01, sum)); };
         // Preserve black gaps and neutral seams, including between near-identical fabrics.
         const brightRidge = Math.max(...drops) < -0.035 && Math.max(...drops) - Math.min(...drops) < 0.07;
         if (distance(before, after) <= 0.06 && distance(chroma(before), chroma(after)) < 0.012 && Math.min(...trough) > 0.065 && ((Math.min(...drops) > 0.018 && Math.max(...drops) - Math.min(...drops) < 0.06 && Math.max(...drops) < 0.25) || brightRidge)) votes++;
       }
       if (votes >= w / 6 * 0.4 && votes >= visible * 0.7) { i++; continue; }
     }
     persistent.push(a);
   }
   edges.splice(0, edges.length, ...persistent);
   result.evidence.horizontalEdges = edges.length;
   const fullWidth = edges.filter(e => e.support >= w * 0.55 && e.right - e.left > w * 0.55 && (e.left <= 6 || e.right >= w - 6)).length >= 5 || edges.filter(e => e.support >= w * 0.35 && e.right - e.left > w * 0.65 && (e.left < w * 0.15 || e.right >= w - 6) && e.right > w * 0.8).length >= 3;
  type Band = { left: number; right: number; top: number; bottom: number; clipped: boolean; darkCandidate: boolean };
  const bands: Band[] = [];
  const broad: Edge[] = [];
   if (fullWidth) for (const edge of edges.filter(e => e.support >= w * 0.55 || (e.support >= w * 0.25 && e.strength >= 0.03 && e.right - e.left > w * 0.65))) {
    const previous = broad.at(-1);
    if (previous && edge.y - previous.y < Math.max(10, h * 0.035)) {
      if (edge.strength * edge.support > previous.strength * previous.support) broad[broad.length - 1] = edge;
    } else broad.push(edge);
  }
  const boundaries = fullWidth ? [{ y: 0, left: 0, right: w, support: w, strength: 0 }, ...broad, { y: h, left: 0, right: w, support: w, strength: 0 }] : edges;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const top = boundaries[i], bottom = boundaries[i + 1], height = bottom.y - top.y;
    if (height < Math.max(12, h * 0.015) || height > h * 0.4) continue;
    let left = fullWidth ? 0 : Math.max(top.left, bottom.left), right = fullWidth ? w : Math.min(top.right, bottom.right);
    if (right - left < w * 0.2) continue;
    if (!fullWidth) {
      // Each bounded band must retain its own side boundaries, not the background between stacks.
      const lefts: number[] = [], rights: number[] = [];
      for (let y = top.y + 6; y < bottom.y - 5; y += 4) {
        for (const side of [left, right]) {
          let best: number | undefined, strength = 0.018;
          for (let x = Math.max(3, Math.floor(side - 8)); x <= Math.min(w - 4, Math.ceil(side + 8)); x++) {
            const a = color(x - 3, y), b = color(x + 3, y);
            if (!a || !b) continue;
            const d = distance(a, b);
            if (d > strength) { strength = d; best = x; }
          }
          if (best !== undefined) (side === left ? lefts : rights).push(best);
        }
      }
      if (lefts.length < (height - 11) / 4 * 0.5 || rights.length < (height - 11) / 4 * 0.5) continue;
      left = median(lefts); right = median(rights);
      if (left <= 3 || right >= w - 3) continue;
    }
    // Evidence must survive inside the band, not only on its occluder's horizontal edges.
    let visible = 0, total = 0;
    for (let y = top.y + 5; y < bottom.y - 4; y += 4) for (let x = left + 4; x < right - 3; x += 4) { total++; if (!mask[Math.floor(y) * w + Math.floor(x)]) visible++; }
    if (!total || visible / total < 0.25) continue;
    let darkCandidate = false;
    if (!fullWidth) {
      const rowColors = [0.3, 0.5, 0.7].map(t => color(Math.floor((left + right) / 2), Math.floor(top.y + height * t))).filter((v): v is number[] => v !== undefined);
      if (!rowColors.some(v => Math.max(...v) - Math.min(...v) >= 0.06) && (right - left) / height < 3) {
        let dark = 0, tested = 0;
        for (const t of [0.3, 0.5, 0.7]) for (let x = left + 6; x < right - 5; x += 6) {
          const y = Math.floor(top.y + height * t);
          if (mask[y * w + Math.floor(x)]) continue;
          const rgb = color(Math.floor(x), y);
          if (rgb) { tested++; if (Math.max(...rgb) < 0.03) dark++; }
        }
        if (!tested || dark / tested < 0.9) continue;
        darkCandidate = true;
      }
    }
    bands.push({ left, right, top: top.y, bottom: bottom.y, clipped: fullWidth || top.y === 0 || bottom.y === h, darkCandidate });
  }
  const groups: Band[][] = [];
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    // Dark pixels alone cannot distinguish fabric from a bezel or clipped shadow.
    // Require three independently supported, similarly sized stack neighbors.
    if (band.darkCandidate) {
      const heights: number[] = [];
      for (const direction of [-1, 1]) {
        let previous = band;
        for (let j = i + direction; j >= 0 && j < bands.length; j += direction) {
          const neighbor = bands[j];
          if (neighbor.darkCandidate || Math.min(Math.abs(neighbor.bottom - previous.top), Math.abs(neighbor.top - previous.bottom)) > 6 || Math.abs(neighbor.left - band.left) >= 12 || Math.abs(neighbor.right - band.right) >= 12) break;
          heights.push(neighbor.bottom - neighbor.top); previous = neighbor;
        }
      }
      const height = band.bottom - band.top, typicalHeight = median(heights);
      if (heights.length < 3 || height < typicalHeight * 0.5 || height > typicalHeight * 2) continue;
    }
    const previous = groups.at(-1)?.at(-1);
    if (previous && band.top - previous.bottom <= 6 && Math.abs(band.left - previous.left) < 12 && Math.abs(band.right - previous.right) < 12) groups.at(-1)!.push(band);
    else groups.push([band]);
  }
   const stacks = groups.filter(group => group.length >= 2);
  if (stacks.length > 1 || bands.length > 30) { result.status = 'ambiguous'; result.evidence.reason = 'multipleBandStacks'; return result; }
  if (!stacks.length) return result;
  if (stacks[0].some(band => band.darkCandidate)) result.evidence.limitations.push('Bounded dark-band geometry only; black fabric, clipped pixels and shadow remain indistinguishable. Preview only, not true-color evidence.');
  result.fabricRegions = stacks[0].map((band, index) => {
    const inset = Math.max(3, Math.min(band.right - band.left, band.bottom - band.top) * 0.06);
    const polygon: Point[] = [[(band.left + inset) * sx, (band.top + inset) * sy], [(band.right - inset) * sx, (band.top + inset) * sy], [(band.right - inset) * sx, (band.bottom - inset) * sy], [(band.left + inset) * sx, (band.bottom - inset) * sy]];
     return { id: `auto-fabric-${index + 1}`, label: `نمونهٔ پیشنهادی ${index + 1}`, order: index + 1, mode: 'bands', polygon, exclusions: [...exclusions, ...localObjects].map(p => p.map(v => [...v] as Point)), background: null, layers: null, direction: null, operatorConfirmed: false, selectionMethod: 'autoDetected', source: 'autoDetected', confidence: band.clipped ? 0.65 : 0.8, geometryStatus: band.clipped ? 'candidate' : 'full', clipped: band.clipped };
  });
   result.status = uncertainBoundary && fullWidth ? 'ambiguous' : 'ready'; result.evidence.reason = uncertainBoundary && fullWidth ? 'foldOrPhysicalBoundary' : fullWidth ? 'clippedRepeatedBands' : 'boundedRepeatedBands';
  return result;
}
