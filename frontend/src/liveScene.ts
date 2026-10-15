import { decodeMarker, sampleMarker, type PixelImage, type Rect } from './marker';
import { bounds, type Point, type Region } from './sampling';
import { detectSwatchLayout } from './swatchDetection';
import { detectNeutralCards } from './neutralCards';
import {selectResponseWitness,type ResponseWitness} from './responseTracking';

export type AutoRegion = Region & { source: 'autoDetected'; confidence: number; geometryStatus?: 'candidate' | 'full'; clipped?: boolean };
export type LiveScene = {
  status: 'ready' | 'needsFraming' | 'ambiguous';
  displayRegion?: AutoRegion;
  displayAperture?: AutoRegion;
  apertureFeedbackSafe?: boolean;
  marker?: Rect;
  fabricRegions: AutoRegion[];
  neutralCandidates: AutoRegion[];
  nextAction: string;
  responseWitness?:ResponseWitness;
   evidence: { markerSequence?: number; markerCandidates: number; markerSentinels?:number;markerRejections?:Record<string,number>; markerOrientation?: 'vertical'; referenceIdentity: 'unknown'; geometryOnly?: true; method: 'boundedRasterGeometry'; limitations: string[]; reason?: string };
};

export function detectLiveScene(image: PixelImage, expectedMarkerSequence?: number, options: { requireReferenceIdentity?: boolean; displayLayout?: 'single' | 'group' | 'liveBands';purpose?:'response' } = {}): LiveScene {
  const evidence: LiveScene['evidence'] = { markerCandidates: 0, referenceIdentity: 'unknown', geometryOnly: true, method: 'boundedRasterGeometry', limitations: ['هندسهٔ پیشنهادی، نه تأیید رنگ فیزیکی یا هویت کارت مرجع.', 'مستطیل یا نوار رنگی به‌تنهایی جنس پارچه را اثبات نمی‌کند؛ گوشی می‌تواند هر سمت پارچه باشد.'] };
   const result: LiveScene = { status: 'needsFraming', fabricRegions: [], neutralCandidates: [], nextAction: 'نمایشگر A را عمودی و کامل روبه‌روی دوربین قرار دهید؛ نشانگر باید افقی باشد. گوشی چرخیدهٔ ۹۰ درجه یا صفحهٔ انتظار قابل اندازه‌گیری نیست.', evidence };
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 32 || image.height < 32 || image.width * image.height > 16_000_000 || image.data.length !== image.width * image.height * 4) return result;
  if (expectedMarkerSequence !== undefined && (!Number.isSafeInteger(expectedMarkerSequence) || expectedMarkerSequence < 0 || expectedMarkerSequence > 0xffffff)) return result;
  const factor = Math.min(1, 640 / Math.max(image.width, image.height));
  const width = Math.floor(image.width * factor), height = Math.floor(image.height * factor);
  const sx = image.width / width, sy = image.height / height;
  const scale = image.data instanceof Uint8ClampedArray ? 255 : 1;
  const grid = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const native = (Math.floor(y * sy) * image.width + Math.floor(x * sx)) * 4;
    if (Number(image.data[native + 3]) / scale < 0.99) return result;
    for (let c = 0; c < 3; c++) {
      const value = Number(image.data[native + c]) / scale;
      if (!Number.isFinite(value) || value < 0 || value > 1) return result;
      grid[(y * width + x) * 3 + c] = value;
    }
  }
  const neutral = detectNeutralCards(image);
  const cardCandidates = (neutral.evidence.candidateGeometry ?? []).filter(candidate => {
    const x = Math.min(width - 1, Math.floor(candidate.polygon.reduce((sum, p) => sum + p[0], 0) / candidate.polygon.length / sx));
    const y = Math.min(height - 1, Math.floor(candidate.polygon.reduce((sum, p) => sum + p[1], 0) / candidate.polygon.length / sy));
    const values = Array.from(grid.subarray((y * width + x) * 3, (y * width + x) * 3 + 3));
    return Math.max(...values) - Math.min(...values) < 0.13;
  });
  const cardExclusions = cardCandidates.map(candidate => {
    const cx = candidate.polygon.reduce((sum, p) => sum + p[0], 0) / candidate.polygon.length;
    const cy = candidate.polygon.reduce((sum, p) => sum + p[1], 0) / candidate.polygon.length;
    return candidate.polygon.map(([x, y]) => [Math.max(0, Math.min(image.width, cx + (x - cx) / 0.7)), Math.max(0, Math.min(image.height, cy + (y - cy) / 0.7))] as [number, number]);
  });
  result.neutralCandidates = cardCandidates.map((candidate, index) => ({ id: `auto-neutral-${index + 1}`, label: 'سطح خنثی پیشنهادی؛ هویت نامعلوم', order: index + 1, mode: 'solid', polygon: candidate.polygon, exclusions: [], background: null, layers: null, direction: null, operatorConfirmed: false, selectionMethod: 'autoDetected', source: 'autoDetected', confidence: 0.6 }));
  const rgb = (x: number, y: number) => {
    const i = (y * width + x) * 3;
    return [grid[i], grid[i + 1], grid[i + 2]];
  };
   const kind = (x: number, y: number) => {
    const i = (y * width + x) * 3;
    const lum = grid[i] * 0.2126 + grid[i + 1] * 0.7152 + grid[i + 2] * 0.0722;
    const low = Math.min(grid[i], grid[i + 1], grid[i + 2]), high = Math.max(grid[i], grid[i + 1], grid[i + 2]);
    return high - low > 0.35 ? -1 : lum < 0.22 ? 0 : lum > 0.72 ? 1 : -1;
  };
  const softKind=(x:number,y:number)=>{
    const i=(y*width+x)*3;
    const lum = grid[i] * 0.2126 + grid[i + 1] * 0.7152 + grid[i + 2] * 0.0722;
    const low = Math.min(grid[i], grid[i + 1], grid[i + 2]), high = Math.max(grid[i], grid[i + 1], grid[i + 2]);
    return high - low > 0.4 ? -1 : lum < 0.38 ? 0 : lum > 0.62 ? 1 : -1;
  };
  const markers: { rect: Rect; sequence: number }[] = [];
  evidence.markerSentinels=0;evidence.markerRejections={};
  const rejectMarker=(reason:string)=>{evidence.markerRejections![reason]=(evidence.markerRejections![reason]??0)+1;};
  const nativeRgb = (x: number, y: number) => {
    const offset = (y * image.width + x) * 4;
    return [0, 1, 2].map(channel => Number(image.data[offset + channel]) / scale);
  };
  const rejectedTall: { left: number; right: number; top: number; bottom: number }[] = [];
  // Small strips need their observed end border, not 28 times a rounded sync run.
  // This path supplies geometry only; default scientific sampling remains >=112px.
  const borderedMarker = (start: number, row: number, pitch: number) => {
    const y = Math.floor(row * sy), estimatedLeft = start * sx, estimatedPitch = pitch * sx;
    if (markers.some(marker => Math.abs(marker.rect.x - estimatedLeft) <= sx * 2 && y >= marker.rect.y && y < marker.rect.y + marker.rect.height)) return true;
    if (rejectedTall.some(candidate => Math.abs(candidate.left - estimatedLeft) <= sx * 2 && y >= candidate.top && y < candidate.bottom)) return true;
    if (estimatedPitch < 2) { rejectMarker('analysisCellResolution'); return false; }
    const rim = (x: number, yy: number) => {
      if (x < 0 || yy < 0 || x >= image.width || yy >= image.height) return false;
      const offset = (yy * image.width + x) * 4;
      const red = Number(image.data[offset]) / scale, green = Number(image.data[offset + 1]) / scale, blue = Number(image.data[offset + 2]) / scale;
      const low = Math.min(red, green, blue), high = Math.max(red, green, blue);
      return high - low < .18 && low > .22 && high < .78;
    };
    const radius = Math.ceil(Math.max(sx, estimatedPitch * 1.5));
    const lefts: number[] = [], rights: number[] = [];
    for (let x = Math.max(1, Math.floor(estimatedLeft - radius)); x <= Math.min(image.width - 2, Math.ceil(estimatedLeft + radius)); x++) {
      if (rim(x - 1, y) && !rim(x, y)) lefts.push(x);
    }
    if (!lefts.length) { rejectMarker('markerBorderIncomplete'); return false; }
    const estimatedRight = estimatedLeft + estimatedPitch * 28;
    // A half-analysis-pixel sync rounding error accumulates over 28 cells.
    // Only actual gray end borders in that quantified window are candidates.
    const endRadius = Math.max(radius, Math.ceil(14 * sx));
    for (let x = Math.max(1, Math.floor(estimatedRight - endRadius)); x <= Math.min(image.width - 2, Math.ceil(estimatedRight + endRadius)); x++) {
      if (!rim(x - 1, y) && rim(x, y)) rights.push(x);
    }
    let found = false;
    for (const left of lefts) for (const right of rights) {
      if (rejectedTall.some(candidate => candidate.left === left && candidate.right === right && y >= candidate.top && y < candidate.bottom)) continue;
      const cell = (right - left) / 28;
      if (cell < 2 || Math.abs(cell - estimatedPitch) > Math.max(sx, 1)) continue;
      const border = nativeRgb(left - 1, y), endBorder = nativeRgb(right, y);
      const borderDifference = Math.max(...border.map((value, channel) => Math.abs(value - endBorder[channel])));
      if (borderDifference > .25) continue;
      // A mixed end-border pixel localizes its edge to the pixel-center interval.
      // Use that observed half-pixel phase, never search phases by decoded bits.
      const sampleLeft = left - (borderDifference > .08 ? .5 : 0);
      const cellsAt = (yy: number) => {
        const cells: number[][] = [];
        for (let index = 0; index < 28; index++) {
          const sum = [0, 0, 0]; let count = 0;
          for (let x = Math.ceil(sampleLeft + (index + .3) * cell); x < sampleLeft + (index + .7) * cell; x++) {
            const values = nativeRgb(x, yy);
            for (let channel = 0; channel < 3; channel++) sum[channel] += values[channel];
            count++;
          }
          cells.push(sum.map(value => value / count));
        }
        return cells;
      };
      let sequence: number;
      const sampled = cellsAt(y);
      try { sequence = decodeMarker(sampled); } catch { rejectMarker('borderedCellAmbiguity'); continue; }
      const dark = (sampled[0][0] + sampled[2][0]) / 2, light = (sampled[1][0] + sampled[3][0]) / 2, threshold = (dark + light) / 2;
      const bits = sampled.map(values => Number(values.reduce((sum, value) => sum + value, 0) / 3 > threshold));
      const transitions: number[] = [];
      for (let x = left + 1; x < right; x++) {
        const a = nativeRgb(x - 1, y).reduce((sum, value) => sum + value, 0) / 3;
        const b = nativeRgb(x, y).reduce((sum, value) => sum + value, 0) / 3;
        if ((a > threshold) !== (b > threshold)) transitions.push(x - .5 + (threshold - a) / (b - a));
      }
      const fitted = bits.flatMap((bit, index) => index && bit !== bits[index - 1] ? [sampleLeft + index * cell] : []);
      if (transitions.length !== fitted.length || transitions.some((position, index) => Math.abs(position - fitted[index]) > Math.max(.6, sx * .6))) { rejectMarker('borderedCellAmbiguity'); continue; }
      const supported = (yy: number) => {
        if (!rim(left - 1, yy) || !rim(right, yy)) return false;
        try { return decodeMarker(cellsAt(yy)) === sequence; } catch { return false; }
      };
      let top = y, bottom = y + 1;
      const maximumHeight = (right - left) / 3;
      while (bottom < image.height && bottom - top <= maximumHeight && supported(bottom)) bottom++;
      while (top > 0 && bottom - top <= maximumHeight && supported(top - 1)) top--;
      if (bottom - top < 2 || bottom - top > maximumHeight) {
        if (bottom - top > maximumHeight) { rejectedTall.push({ left, right, top, bottom }); found = true; }
        rejectMarker('borderedRowSupport'); continue;
      }
      const closed = (yy: number, direction: number) => {
        const rows: number[] = [];
        for (let index = 0; index < 28; index++) {
          const x = Math.floor(left + (index + .5) * cell);
          let edge = -1;
          for (let offset = 0; offset <= Math.ceil(cell); offset++) {
            const candidateY = yy + direction * offset;
            if (rim(x, candidateY) && nativeRgb(x, candidateY).every((value, channel) => Math.abs(value - border[channel]) <= .18)) { edge = candidateY; break; }
          }
          if (edge < 0) return false;
          rows.push(edge);
        }
        // Observe a narrow near-linear border, allowing mild slant but not a
        // disconnected collection of gray pixels around a partial strip.
        return Math.max(...rows) - Math.min(...rows) <= Math.ceil(cell) && rows.every((edge, index) => Math.abs(edge - (rows[0] + (rows[27] - rows[0]) * index / 27)) <= 1.8);
      };
      if (!closed(top - 1, -1) || !closed(bottom, 1)) { rejectMarker('markerBorderIncomplete'); continue; }
      const rect = { x: sampleLeft, y: top, width: right - left, height: bottom - top };
      try {
        if (decodeMarker(sampleMarker(image, rect, { purpose: 'analysisGeometry' })) !== sequence) { rejectMarker('nativeSequenceMismatch'); continue; }
      } catch { rejectMarker('nativeCellAmbiguity'); continue; }
      if (!markers.some(m => Math.abs(m.rect.x - left) < 2 && Math.abs(m.rect.y - top) < 4)) markers.push({ rect, sequence });
      found = true;
    }
    if (!found && (!lefts.length || !rights.length)) rejectMarker('markerBorderIncomplete');
    return found;
  };
  const rowMatches = (x: number, y: number, cell: number, bits: number[]) => bits.every((bit, i) => [0.2, 0.5, 0.8].every(t => kind(Math.floor(x + (i + t) * cell), y) === bit));
  for (let y = 1; y < height - 1; y += 2) {
    for(const tolerant of [false,true]){
    const locator=tolerant?softKind:kind;
     const runs: { x: number; length: number; kind: number }[] = [];
    for (let x = 0; x < width;) {
       const start = x, value = locator(x, y);
       while (++x < width && locator(x, y) === value) { /* scan one run */ }
       runs.push({ x: start, length: x - start, kind: value });
     }
     // Antialiased small dark cells can contain one undecidable edge pixel.
     // Merge only for locating white pairs; native 28-cell decoding remains mandatory.
     if(tolerant)for(let index=1;index<runs.length;index++)if(runs[index].kind!==1&&runs[index-1].kind!==1){
       runs[index-1].length+=runs[index].length;runs[index-1].kind=-1;runs.splice(index--,1);
     }
    for (let i = 0; i < runs.length - 3; i++) {
      const a = runs[i], b = runs[i + 1], c = runs[i + 2], d = runs[i + 3];
       if ((a.kind !== 0 && !(tolerant&&a.kind===-1)) || b.kind !== 1 || (c.kind !== 0 && !(tolerant&&c.kind===-1)) || d.kind !== 1) continue;
        evidence.markerSentinels++;
        let cell = (b.length + c.length) / 2, markerWidth = cell * 28, start = a.x;
        if (cell >= 2 && markerWidth < 168 && Math.abs(b.length - c.length) <= 1 && d.length >= Math.max(1, cell - 2)) {
          const boundedStart = b.x - (d.x - b.x) / 2;
          if (borderedMarker(boundedStart, y, (d.x - b.x) / 2)) continue;
        }
       if (cell < 2 || markerWidth * sx < 70 || (tolerant?a.length<cell-1:Math.abs(a.length-cell)>1) || Math.abs(b.length - c.length) > (tolerant ? Math.max(2, cell * 0.6) : 1) || d.length < cell - 1 || a.x <= 0 || b.x-cell+markerWidth >= width) {rejectMarker('sentinelShapeOrResolution');continue;}
        if(tolerant){
          cell=(d.x-b.x)/2;start=b.x-cell;markerWidth=cell*28;
          if(markerWidth*sx<70||start<=0||start+markerWidth>=width){rejectMarker('sentinelShapeOrResolution');continue;}
         if(markers.some(m=>y*sy>=m.rect.y&&y*sy<m.rect.y+m.rect.height&&start*sx<m.rect.x+m.rect.width&&(start+markerWidth)*sx>m.rect.x))continue;
         const cellsAt=(yy:number)=>Array.from({length:28},(_,index)=>{
           const sum=[0,0,0];let count=0;
           for(let xx=Math.ceil((start+(index+.3)*cell)*sx);xx<(start+(index+.7)*cell)*sx;xx++){
             const offset=(Math.floor(yy*sy)*image.width+xx)*4;
             for(let channel=0;channel<3;channel++)sum[channel]+=Number(image.data[offset+channel])/scale;
             count++;
           }
           return sum.map(value=>value/count);
         });
         let sequence:number;try{sequence=decodeMarker(cellsAt(y));}catch{rejectMarker('ambiguousCells');continue;}
         const supported=(yy:number)=>{try{return decodeMarker(cellsAt(yy))===sequence;}catch{return false;}};
         let top=y,bottom=y+1;
         while(top>0&&supported(top-1))top--;
         while(bottom<height&&supported(bottom))bottom++;
          if(top===0||bottom===height||(bottom-top)*sy<2||bottom-top>markerWidth/3){rejectMarker('stripHeightSupport');continue;}
         const rect={x:start*sx,y:top*sy,width:markerWidth*sx,height:(bottom-top)*sy};
          try{if(decodeMarker(sampleMarker(image,rect,{purpose:'analysisGeometry'}))!==sequence){rejectMarker('nativeSequenceMismatch');continue;}}catch{rejectMarker('nativeCellAmbiguity');continue;}
         if(!markers.some(m=>Math.abs(m.rect.x-rect.x)<2&&Math.abs(m.rect.y-rect.y)<4)){markers.push({rect,sequence});if(markers.length>=32)break;}
         continue;
       }
      if (markers.some(m => Math.abs(m.rect.x / sx - a.x) < 2 && y * sy >= m.rect.y && y * sy < m.rect.y + m.rect.height)) continue;
      // Sentinel edges at native resolution avoid accumulating downsample rounding across 28 cells.
       const nativeKind = (x: number) => {
         const index = (Math.floor(y * sy) * image.width + x) * 4;
         const values = [0, 1, 2].map(channel => Number(image.data[index + channel]) / scale);
         if (Math.max(...values) - Math.min(...values) > .15) return -1;
         return Math.max(...values) < .25 ? 0 : Math.min(...values) > .75 ? 1 : -1;
       };
      const edge = (position: number, leftKind: number, rightKind: number) => {
        for (let x = Math.max(1, Math.floor(position * sx - sx - 1)); x <= Math.min(image.width - 1, Math.ceil(position * sx + sx + 1)); x++) if (nativeKind(x - 1) === leftKind && nativeKind(x) === rightKind) return x;
        return undefined;
      };
       const e1 = edge(b.x, 0, 1), e2 = edge(c.x, 1, 0), e3 = edge(d.x, 0, 1);
       if (e1 === undefined || e2 === undefined || e3 === undefined || Math.abs((e2 - e1) - (e3 - e2)) > 1) {rejectMarker('nativeSentinelEdges');continue;}
      let left = e1 - 1, right = e3;
      while (left > 0 && nativeKind(left - 1) === 0) left--;
      while (right < image.width && nativeKind(right) !== -1) right++;
      if (left === 0 || right === image.width) continue;
      markerWidth = (right - left) / sx; cell = markerWidth / 28; start = left / sx;
      if ([e1 - left, e2 - e1, e3 - e2].some(span => Math.abs(span / sx - cell) > Math.max(1, 1 / sx))) continue;
      if (start <= 0 || start + markerWidth >= width) continue;
      const cells = Array.from({ length: 28 }, (_, index) => rgb(Math.floor(start + (index + 0.5) * cell), y));
      let sequence: number;
      try { sequence = decodeMarker(cells); } catch { continue; }
      const bits = cells.map(v => Number((v[0] + v[1] + v[2]) / 3 > 0.5));
      if (!rowMatches(start, y, cell, bits)) continue;
      let top = y, bottom = y + 1;
      while (top > 0 && rowMatches(start, top - 1, cell, bits)) top--;
      while (bottom < height && rowMatches(start, bottom, cell, bits)) bottom++;
      if (top === 0 || bottom === height || (bottom - top) * sy < 4 || bottom - top > markerWidth / 3) continue;
      const rect = { x: start * sx, y: top * sy, width: markerWidth * sx, height: (bottom - top) * sy };
      try { if (decodeMarker(sampleMarker(image, rect)) !== sequence) continue; } catch { continue; }
      markers.push({ rect, sequence });
      if (markers.length >= 32) break;
     }
     if(markers.length>=32)break;
    }
     if (markers.length >= 32) break;
  }
   evidence.markerCandidates = markers.length;
   if (!markers.length) {
     // Vertical locator is diagnostic only: sampleMarker/capture still require a
     // horizontal strip. Never rotate marker proof silently into another aperture.
     for (let x = 1; x < width - 1 && !evidence.markerOrientation; x += 3) {
       const runs: { y: number; length: number; kind: number }[] = [];
       for (let y = 0; y < height;) {
         const start = y, value = kind(x, y);
         while (++y < height && kind(x, y) === value) { /* scan vertical run */ }
         runs.push({ y: start, length: y - start, kind: value });
       }
       for (let i = 0; i < runs.length - 3; i++) {
         const a = runs[i], b = runs[i + 1], c = runs[i + 2], d = runs[i + 3], cell = (b.length + c.length) / 2;
         if (a.kind !== 0 || b.kind !== 1 || c.kind !== 0 || d.kind !== 1 || cell < 2 || cell * 28 * sy < 112 || Math.abs(a.length - cell) > 1 || Math.abs(b.length - c.length) > 1 || a.y <= 0 || a.y + cell * 28 >= height) continue;
         try {
           const cells = Array.from({ length: 28 }, (_, bit) => rgb(x, Math.floor(a.y + (bit + 0.5) * cell)));
           decodeMarker(cells);
           const bits = cells.map(v => Number((v[0] + v[1] + v[2]) / 3 > 0.5));
           if (!bits.every((bit, index) => [0.2, 0.5, 0.8].every(t => kind(x, Math.floor(a.y + (index + t) * cell)) === bit))) continue;
           let support = 0;
           for (let xx = Math.max(0, x - 2); xx <= Math.min(width - 1, x + 2); xx++) if (bits.every((bit, index) => kind(xx, Math.floor(a.y + (index + 0.5) * cell)) === bit)) support++;
           if (support >= 4) { evidence.markerOrientation = 'vertical'; break; }
         } catch { /* unknown content, not a locator */ }
       }
     }
   }
  const matching = markers.filter(m => expectedMarkerSequence === undefined || m.sequence === expectedMarkerSequence);
  if (matching.length !== 1) {
     evidence.reason = markers.length ? 'displayMarkerMismatch' : 'displayMarkerMissing';
      if (evidence.markerOrientation === 'vertical') evidence.reason = 'displayMarkerOrientationUnsupported';
     if(options.purpose==='response'){
       result.responseWitness=selectResponseWitness(image,neutral);
       result.nextAction=markers.length?'نشانگر واقعی با فرمان جاری یکسان نیست؛ منتظر رندر تازهٔ A بمانید.':'نشانگر صفحهٔ A دیده نشد؛ گوشی A را عمودی و نزدیک‌تر داخل قاب بگذارید.';
       return result;
     }
    if (markers.length) {
      // A readable stale marker can conservatively mask its neighborhood, never authorize capture.
      const suspectScreens = markers.slice(0, 12).map(({ rect }) => [[Math.max(0, rect.x - rect.width * 0.1), Math.max(0, rect.y - rect.width * 2.5)], [Math.min(image.width, rect.x + rect.width * 1.1), Math.max(0, rect.y - rect.width * 2.5)], [Math.min(image.width, rect.x + rect.width * 1.1), Math.min(image.height, rect.y + rect.height + rect.width * 0.1)], [Math.max(0, rect.x - rect.width * 0.1), Math.min(image.height, rect.y + rect.height + rect.width * 0.1)]] as [number, number][]);
      result.fabricRegions = detectSwatchLayout(image, [...cardExclusions, ...suspectScreens]).fabricRegions;
    } else {
      result.fabricRegions = detectSwatchLayout(image, cardExclusions).fabricRegions;
      if (options.displayLayout && options.displayLayout !== 'single') {
        // Without any locator, a bounded colorful rectangle may be A itself. Only broad clipped background bands are safe preview candidates.
        result.fabricRegions = result.fabricRegions.filter(region => 'clipped' in region && region.clipped === true);
      }
    }
    if (matching.length > 1) { result.status = 'ambiguous'; result.nextAction = 'بیش از یک نشانگر معتبر دیده می‌شود؛ فقط نمایشگر A را در قاب نگه دارید.'; }
    else if (markers.length) result.nextAction = 'نشانگر با فرمان جاری یکسان نیست؛ نمایشگر A را تازه کنید و قاب را ثابت نگه دارید.';
    return result;
  }
  const marker = matching[0];
  evidence.markerSequence = marker.sequence;
  result.marker = marker.rect;
  const mx = marker.rect.x / sx, my = marker.rect.y / sy, mw = marker.rect.width / sx;
  const distance = (a: number[], b: number[]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  const pixelDistance = (x: number, y: number, color: number[]) => {
    const i = (y * width + x) * 3;
    return Math.max(Math.abs(grid[i] - color[0]), Math.abs(grid[i + 1] - color[1]), Math.abs(grid[i + 2] - color[2]));
  };
  // Local edges, unlike a center-color flood, survive changing display drives
  // and smooth camera shading. Ratios constrain the search, never supply edges.
  const edgeDistance = (x: number, y: number, vertical: boolean) => {
    const a = (y * width + x) * 3, b = vertical ? a - width * 3 : a - 3;
    return Math.max(Math.abs(grid[a] - grid[b]), Math.abs(grid[a + 1] - grid[b + 1]), Math.abs(grid[a + 2] - grid[b + 2]));
  };
  const sustainedSide = (x: number, y: number) => {
    if (edgeDistance(x, y, false) < 0.025) return false;
    let support = 0;
    for (let yy = Math.max(1, y - 2); yy <= Math.min(height - 1, y + 2); yy++) {
      for (let xx = Math.max(1, x - 1); xx <= Math.min(width - 1, x + 1); xx++) if (edgeDistance(xx, yy, false) >= 0.025) { support++; break; }
    }
    return support >= 3;
  };
  const patches: { rect: Rect; feedbackSafe: boolean }[] = [];
  let aperture: { rect: Rect; left: number; right: number; minLeft: number; maxRight: number } | undefined;
  const closed = (y: number, left: number, right: number) => {
    const radius = Math.ceil(mw * 0.08);
    let support = 0;
    for (let i = 0; i < 16; i++) {
      const x = Math.floor(left + (i + 0.5) * (right - left) / 16);
      for (let yy = Math.max(1, y - radius); yy <= Math.min(height - 1, y + radius); yy++) if (edgeDistance(x, yy, true) >= 0.025) { support++; break; }
    }
    return support >= 12;
  };
  const isLivePreview = options.displayLayout === 'liveBands';
  const maxRightFactor = isLivePreview ? 1.35 : 1.1;
  const maxWidthFactor = isLivePreview ? 1.35 : 1.2;
  const maxGapFactor = isLivePreview ? 0.45 : 0.3;

  const rawSegments: { rect: Rect; closedTop: boolean; closedBot: boolean }[] = [];
  const finish = () => {
    if (aperture) {
      const rect = aperture.rect;
      if (rect.y > Math.max(1, Math.floor(my - mw * 2.5)) && rect.width >= mw * 0.6 && rect.height >= 8) {
        rawSegments.push({ rect, closedTop: closed(rect.y, rect.x, rect.x + rect.width), closedBot: closed(rect.y + rect.height, rect.x, rect.x + rect.width) });
      }
      if (rect.y > Math.max(1, Math.floor(my - mw * 2.5)) && rect.width >= mw * 0.6 && rect.height >= mw * 0.25 && my - rect.y - rect.height < mw * maxGapFactor && closed(rect.y, rect.x, rect.x + rect.width) && closed(rect.y + rect.height, rect.x, rect.x + rect.width)) {
        let feedbackSafe = false;
        // A color band's own boundary cannot prove the full screen footprint.
        // Require the same separately bounded rim on all four observed sides.
        const rim = rgb(rect.x - 1, Math.floor(rect.y + rect.height / 2));
        const radius = Math.ceil(mw * 0.08);
        const horizontal = (y: number, top: boolean) => {
          if (y <= 1 || y >= height - 1) return -1;
          const thickness: number[] = [];
          for (let i = 0; i < 16; i++) {
            const x = Math.floor(rect.x + (i + 0.5) * rect.width / 16);
            if (edgeDistance(x, y, true) < 0.025 || pixelDistance(x, top ? y - 1 : y, rim) >= 0.025) continue;
            for (let d = 1; d <= radius; d++) {
              const yy = top ? y - d : y + d;
              if (yy <= 0 || yy >= height) break;
              if (edgeDistance(x, yy, true) >= 0.025) { thickness.push(d); break; }
            }
          }
          thickness.sort((a, b) => a - b);
          return thickness.length >= 12 ? thickness[Math.floor(thickness.length / 2)] : -1;
        };
        let top = -1, bottom = -1, topThickness = -1, bottomThickness = -1;
        for (let y = Math.max(2, rect.y); y <= Math.min(height - 2, rect.y + radius); y++) {
          const thickness = horizontal(y, true);
          if (thickness > 0) { top = y; topThickness = thickness; break; }
        }
        for (let y = Math.min(height - 2, rect.y + rect.height); y >= rect.y + rect.height - radius; y--) {
          const thickness = horizontal(y, false);
          if (thickness > 0) { bottom = y; bottomThickness = thickness; break; }
        }
        if (top > 0 && bottom - top >= mw * 0.25 && Math.max(...rim) - Math.min(...rim) < 0.12) {
          let sides = 0, sideUncertainty = 0;
          const sideThickness: number[] = [];
          for (let i = 0; i < 16; i++) {
            const y = Math.floor(top + (i + 0.5) * (bottom - top) / 16);
            let leftOffset = -1, rightOffset = -1;
            for (let offset = 0; offset <= 2; offset++) {
              if (leftOffset < 0 && rect.x - offset > 0 && pixelDistance(rect.x - offset - 1, y, rim) < 0.025 && edgeDistance(rect.x - offset, y, false) >= 0.025) leftOffset = offset;
              if (rightOffset < 0 && rect.x + rect.width + offset < width && pixelDistance(rect.x + rect.width + offset, y, rim) < 0.025 && edgeDistance(rect.x + rect.width + offset, y, false) >= 0.025) rightOffset = offset;
            }
            if (leftOffset < 0 || rightOffset < 0) continue;
            let left = 0, right = 0;
            for (let d = 1; d <= radius; d++) {
              if (!left && rect.x - leftOffset - d > 0 && edgeDistance(rect.x - leftOffset - d, y, false) >= 0.025) left = d;
              if (!right && rect.x + rect.width + rightOffset + d < width && edgeDistance(rect.x + rect.width + rightOffset + d, y, false) >= 0.025) right = d;
            }
            if (left && right) {
              sideUncertainty = Math.max(sideUncertainty, leftOffset, rightOffset); sides++;
              sideThickness.push(left, right);
            }
          }
          // Rim-connected content hides the inner edge. A nearby outer edge
          // is insufficient if its thickness disagrees with the other sides.
          const thickness = [topThickness, bottomThickness, ...sideThickness];
          const coherentRim = (Math.max(...thickness) - Math.min(...thickness)) * Math.max(sx, sy) <= 5;
          feedbackSafe = sides >= 12 && coherentRim && sideUncertainty * Math.max(sx, sy) <= 4 && sideUncertainty <= Math.min(rect.width, bottom - top) * 0.03;
          if (feedbackSafe) { rect.y = top; rect.height = bottom - top; }
        }
        patches.push({ rect, feedbackSafe });
      }
    }
    aperture = undefined;
  };
  for (let y = Math.max(1, Math.floor(my - mw * 2.5)); y < my; y++) {
    let left = -1, right = -1;
    for (let x = Math.min(width - 1, Math.floor(mx + mw * 0.25)); x >= Math.max(1, Math.floor(mx - mw * 0.15)); x--) if (sustainedSide(x, y)) { left = x; break; }
    for (let x = Math.max(1, Math.ceil(mx + mw * 0.75)); x < Math.min(width, mx + mw * maxRightFactor); x++) if (sustainedSide(x, y)) { right = x; break; }
    if (left <= 0 || right >= width || right - left < mw * 0.6 || right - left > mw * maxWidthFactor) { finish(); continue; }
    if (aperture && Math.abs(aperture.left - left) <= 3 && Math.abs(aperture.right - right) <= 3) {
      // Intersect the side traces, rather than expanding into a tilted bezel.
      const x = Math.max(aperture.rect.x, left), end = Math.min(aperture.rect.x + aperture.rect.width, right);
      aperture.rect.x = x; aperture.rect.width = end - x; aperture.rect.height++;
      aperture.minLeft = Math.min(aperture.minLeft, left); aperture.maxRight = Math.max(aperture.maxRight, right);
      aperture.left = left; aperture.right = right;
    } else { finish(); aperture = { rect: { x: left, y, width: right - left, height: 1 }, left, right, minLeft: left, maxRight: right }; }
  }
  finish();
  if (patches.length === 0 && isLivePreview) {
    const firstTop = rawSegments.find(s => s.closedTop);
    const lastBot = [...rawSegments].reverse().find(s => s.closedBot && my - s.rect.y - s.rect.height < mw * maxGapFactor);
    if (firstTop && lastBot && lastBot.rect.y + lastBot.rect.height > firstTop.rect.y) {
      const y = firstTop.rect.y;
      const h = (lastBot.rect.y + lastBot.rect.height) - y;
      const x = Math.max(firstTop.rect.x, lastBot.rect.x);
      const w = Math.min(firstTop.rect.x + firstTop.rect.width, lastBot.rect.x + lastBot.rect.width) - x;
      if (h >= mw * 0.4 && w >= mw * 0.5) {
        patches.push({ rect: { x, y, width: w, height: h }, feedbackSafe: false });
      }
    }
  }
  result.marker = marker.rect;
  if (patches.length !== 1) {
    result.status = patches.length > 1 ? 'ambiguous' : 'needsFraming';
    result.nextAction = 'سطح رنگی بزرگ بالای نشانگر باید صاف، کامل و بدون زاویه یا بازتاب در قاب دیده شود.';
    evidence.reason = 'displayApertureMissing';
    if(options.purpose==='response'){result.responseWitness=selectResponseWitness(image,neutral);return result;}
    const suspectScreen: [number, number][] = [[Math.max(0, marker.rect.x - marker.rect.width * 0.1), Math.max(0, marker.rect.y - marker.rect.width * 2.5)], [Math.min(image.width, marker.rect.x + marker.rect.width * 1.1), Math.max(0, marker.rect.y - marker.rect.width * 2.5)], [Math.min(image.width, marker.rect.x + marker.rect.width * 1.1), Math.min(image.height, marker.rect.y + marker.rect.height + 8 * sy)], [Math.max(0, marker.rect.x - marker.rect.width * 0.1), Math.min(image.height, marker.rect.y + marker.rect.height + 8 * sy)]];
    result.fabricRegions = detectSwatchLayout(image, [...cardExclusions, suspectScreen]).fabricRegions;
    return result;
  }
  const patch = patches[0].rect;
  const makeRegion = (rect: Rect, id: string, label: string, order: number): AutoRegion => {
    const inset = Math.max(2, Math.min(rect.width, rect.height) * 0.06);
    const x0 = (rect.x + inset) * sx, y0 = (rect.y + inset) * sy;
    const x1 = (rect.x + rect.width - inset) * sx, y1 = (rect.y + rect.height - inset) * sy;
    return { id, label, order, mode: 'solid', polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], exclusions: [], background: null, layers: null, direction: null, operatorConfirmed: false, selectionMethod: 'autoDetected', source: 'autoDetected', confidence: 0.9 };
  };
  result.marker = marker.rect;
  result.displayRegion = makeRegion(patch, 'auto-display', 'سطح نمایشگر A', 0);
  result.displayAperture = { ...result.displayRegion, polygon: [[patch.x * sx, patch.y * sy], [(patch.x + patch.width) * sx, patch.y * sy], [(patch.x + patch.width) * sx, (patch.y + patch.height) * sy], [patch.x * sx, (patch.y + patch.height) * sy]] };
  result.apertureFeedbackSafe = patches[0].feedbackSafe;
  if(options.purpose==='response'){
    result.responseWitness=selectResponseWitness(image,neutral,result.displayRegion);
    result.status=result.responseWitness.status==='selected'?'ready':result.responseWitness.status;
    evidence.reason=result.responseWitness.status==='selected'?'responseWitnessSelected':result.responseWitness.status==='ambiguous'?'multipleResponseWitnesses':'responseWitnessMissing';
    result.nextAction=result.responseWitness.status==='selected'?'صفحه و کارت شاهد پیشنهادی دیده شدند؛ همان کارت را ثابت نگه دارید. مقادیر مرجع نامعلوم است.':result.responseWitness.status==='ambiguous'?'چند کارت شاهد میانی مشابه دیده شد؛ فقط یک کارت جدا کنار A نگه دارید.':'یک کارت خاکستری جدا کنار A بگذارید؛ همهٔ لبه‌های کارت باید داخل قاب دیده شوند.';
    return result;
  }
  const displayLeft = Math.max(0, Math.min(mx, patch.x) - 4), displayRight = Math.min(width, Math.max(mx + mw, patch.x + patch.width) + 4);
  const displayExclusion: [number, number][] = [[displayLeft * sx, Math.max(0, patch.y - 8) * sy], [displayRight * sx, Math.max(0, patch.y - 8) * sy], [displayRight * sx, Math.min(height, my + marker.rect.height / sy + 8) * sy], [displayLeft * sx, Math.min(height, my + marker.rect.height / sy + 8) * sy]];
  const visibleLayout = detectSwatchLayout(image, [...cardExclusions, displayExclusion]);
  const phoneIsRight = mx > width / 2;
  result.fabricRegions = visibleLayout.fabricRegions.flatMap(region => {
    const poly = region.polygon;
    const b = bounds(poly);
    // If the swatch spans right across the phone (e.g. full-width carpet detection):
    if (phoneIsRight && b.x < displayLeft * sx && b.x + b.width > displayLeft * sx) {
      const right = displayLeft * sx - 4;
      if (right <= b.x + 10) return [];
      return [{ ...region, polygon: [[b.x, poly[0][1]], [right, poly[0][1]], [right, poly[2][1]], [b.x, poly[2][1]]] as Point[] }];
    } else if (!phoneIsRight && b.x < displayRight * sx && b.x + b.width > displayRight * sx) {
      const left = displayRight * sx + 4;
      if (b.x + b.width <= left + 10) return [];
      return [{ ...region, polygon: [[left, poly[0][1]], [b.x + b.width, poly[0][1]], [b.x + b.width, poly[2][1]], [left, poly[2][1]]] as Point[] }];
    }
    return [region];
  });
  if (visibleLayout.status === 'ambiguous') { result.status = 'ambiguous'; evidence.reason = 'multipleBandStacks'; result.nextAction = 'چند مجموعهٔ نوار دیده شد؛ فقط یک کالیته را در قاب بگذارید.'; return result; }
  const outside = (x: number, y: number) => !(x >= displayLeft && x <= displayRight && y >= patch.y - 8 && y <= my + marker.rect.height / sy + 8);
  const flat: { rect: Rect; color: number[] }[] = [];
  let previous: { rect: Rect; color: number[] }[] = [];
  for (let y = 0; y < height; y++) {
    const current: typeof previous = [];
    for (let x = 0; x < width;) {
      if (!outside(x, y)) { x++; continue; }
      const left = x, seedColor = rgb(x, y);
      while (++x < width && outside(x, y) && pixelDistance(x, y, seedColor) < 0.02) { /* allow bounded noise across a flat row */ }
      if (left <= 0 || x >= width || !outside(left - 1, y) || !outside(x, y) || x - left < Math.max(24, width * 0.05)) continue;
      // Row medians retain close inter-row boundaries without letting individual noisy pixels split a swatch.
      const samples: number[][] = [[], [], []];
      for (let position = left; position < x; position += Math.max(1, Math.floor((x - left) / 64))) {
        const i = (y * width + position) * 3;
        for (let c = 0; c < 3; c++) samples[c].push(grid[i + c]);
      }
      const color = samples.map(values => { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)]; });
      const existing = previous.find(p => Math.abs(p.rect.x - left) <= 1 && Math.abs(p.rect.width - (x - left)) <= 1 && distance(p.color, color) < 0.009);
      if (existing) { existing.rect.height++; current.push(existing); }
      else current.push({ rect: { x: left, y, width: x - left, height: 1 }, color });
    }
    previous.filter(p => !current.includes(p)).forEach(p => flat.push(p));
    previous = current;
  }
  flat.push(...previous);
  const candidates = flat.filter(p => p.rect.y > 0 && p.rect.y + p.rect.height < height && p.rect.height >= Math.max(12, height * 0.02));
  const bands = candidates.filter(p => candidates.some(q => p !== q && Math.abs(p.rect.x - q.rect.x) <= 2 && Math.abs(p.rect.width - q.rect.width) <= 2 && (Math.abs(p.rect.y + p.rect.height - q.rect.y) <= 3 || Math.abs(q.rect.y + q.rect.height - p.rect.y) <= 3)));
  const groups: typeof bands[] = [];
  const remaining = new Set(bands);
  while (remaining.size) {
    const first = remaining.values().next().value!;
    const group = [first]; remaining.delete(first);
    for (let index = 0; index < group.length; index++) for (const p of remaining) {
      const q = group[index];
      if (Math.abs(p.rect.x - q.rect.x) <= 2 && Math.abs(p.rect.width - q.rect.width) <= 2 && (Math.abs(p.rect.y + p.rect.height - q.rect.y) <= 3 || Math.abs(q.rect.y + q.rect.height - p.rect.y) <= 3)) { group.push(p); remaining.delete(p); }
    }
    groups.push(group);
  }
  if (groups.length > 1 || bands.length > 30) {
    result.status = 'ambiguous';
    result.fabricRegions = [];
    result.nextAction = 'چند قاب پارچه یا نوار بسیار زیاد دیده می‌شود؛ فقط یک مجموعهٔ پارچه را کامل در قاب نگه دارید.';
    return result;
  }
  bands.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  if (!result.fabricRegions.length) result.fabricRegions = bands.slice(0, 30).map((p, index) => ({ ...makeRegion(p.rect, `auto-fabric-${index + 1}`, `نمونهٔ پارچه ${index + 1}`, index + 1), mode: 'bands', confidence: 0.8 }));
  if (!result.neutralCandidates.length) result.neutralCandidates = candidates.filter(p => !bands.includes(p) && Math.max(...p.color) - Math.min(...p.color) < 0.035 && p.color[0] > 0.15 && p.color[0] < 0.98 && p.rect.width / p.rect.height > 0.5 && p.rect.width / p.rect.height < 3).slice(0, 12).map((p, index) => ({ ...makeRegion(p.rect, `auto-neutral-${index + 1}`, `سطح خنثی پیشنهادی ${index + 1}؛ هویت نامعلوم`, index + 1), confidence: 0.6 }));
  if (!result.fabricRegions.length) {
    const solids = candidates.filter(p => (p.rect.x + p.rect.width < mx - 8 || p.rect.x > mx + mw + 8) && p.rect.width >= width * 0.12 && p.rect.height >= height * 0.12 && p.rect.width / p.rect.height >= 0.3 && p.rect.width / p.rect.height <= 3 && Math.max(...p.color) - Math.min(...p.color) >= 0.06);
    if (solids.length > 1) {
      result.status = 'ambiguous';
      result.nextAction = 'چند سطح رنگی کنار نمایشگر دیده شد؛ فقط یک نمونهٔ پارچه را با حاشیهٔ کامل کنار گوشی قرار دهید.';
      return result;
    }
    if (solids.length === 1) result.fabricRegions = [{ ...makeRegion(solids[0].rect, 'auto-fabric-1', 'نمونهٔ پارچه ۱', 1), confidence: 0.75 }];
  }
  if (result.fabricRegions.length) {
    result.status = 'ready';
    result.nextAction = 'نمایشگر و نوارهای پارچه پیدا شدند؛ قاب را ثابت نگه دارید. هویت کارت مرجع هنوز نامعلوم است.';
  } else result.nextAction = 'پارچه را کنار نمایشگر، کامل و صاف در قاب بگذارید؛ نوارها باید از حاشیه و پس‌زمینه جدا دیده شوند.';
  if (result.neutralCandidates.length && options.requireReferenceIdentity !== false && options.displayLayout !== 'liveBands') {
    result.status = 'ambiguous';
    result.nextAction = 'سطح خنثی دیده شد، اما هویت مرجع از تصویر معلوم نیست؛ تطبیق کارت فقط با چیدمان مرجع ثبت‌شده ممکن است.';
  }
  return result;
}
