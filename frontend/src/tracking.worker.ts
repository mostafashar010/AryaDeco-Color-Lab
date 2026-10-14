import { detectNeutralCards } from './neutralCards';
import { detectLiveScene } from './liveScene';
import { bounds, contains, type Point, type Region } from './sampling';
import {sampleMarker,type Rect} from './marker';
import type { Mode } from './session';
import { computeTracking, type DisplayBandContext, type PreviewRejectionReason,type TrackingFrame, type TrackingPhase, type TrackingState } from './liveTracking';
import {samplePreviewBands,inspectScreenBands} from './previewSampling';
import{responseCardRegions}from'./responseTracking';

export type TrackingRequest = { id: number; generation: number; phase: TrackingPhase; expectedSequence?: number;displayBands?:DisplayBandContext; mode?: Mode;purpose?:'response'; image: { width: number; height: number; data: Uint8ClampedArray }; frame: TrackingFrame };
export type TrackingResponse = { id: number; generation: number; frame: TrackingFrame; tracking?: TrackingState['tracking']; error?: string };
type Fingerprint = { values: Float32Array; mask: Uint8Array; width: number; height: number; analysisWidth: number; analysisHeight: number; phase: TrackingPhase };
type Appearance = { id: string; polygon: Point[]; exclusions:Point[][];descriptor: Float32Array };
export type WorkerTrackingState = { generation: number; mode?: Mode;purpose?:'response'; tracking: TrackingState; fingerprint: Fingerprint; appearance: Appearance[];displayAnchor?:{aperture:Region;region:Region;marker:Rect} };

// Only geometry leaves this worker. The small luminance fingerprint is ephemeral.
export function processTrackingFrame(request: TrackingRequest, previous: WorkerTrackingState | null): WorkerTrackingState {
  if (previous && (request.frame.presentedFrames <= previous.tracking.tracking.frame.presentedFrames || (request.frame.timeSource === previous.tracking.tracking.frame.timeSource && request.frame.mediaTime <= previous.tracking.tracking.frame.mediaTime))) return previous;
  const started = performance.now();
  const { image, phase, frame } = request;
  if (Math.max(image.width, image.height) > 640 || image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) throw new Error('Invalid bounded tracking frame');
  const sx = frame.width / image.width, sy = frame.height / image.height;
  const mapPolygon = (polygon: Point[]): Point[] => polygon.map(([x, y]) => [x * sx, y * sy]);
  const mapRegion = (r: Region): Region => ({ id: r.id, label: r.label, order: r.order, mode: r.mode, polygon: mapPolygon(r.polygon), exclusions: r.exclusions.map(mapPolygon), background: r.background, layers: r.layers, direction: r.direction, selectionMethod: 'autoDetected', operatorConfirmed: false });
  let status: TrackingState['tracking']['status'], nextAction: string, regions: Region[] = [], marker: Rect | null = null;
  let candidateRegions: Region[] = [], debug: TrackingState['tracking']['debug'];
  let candidateCount = 0, cardCount = 0, fabricCount = 0, neutralCount = 0, markerCandidates = 0, markerSequence: number | undefined;
  const excluded: Point[][] = [];
  let fabric: Region[] = [], recognizedScreen = false;
  let neutralCardRegions:TrackingState['tracking']['neutralCardRegions']=[];
  let responseWitnessEvidence:TrackingState['tracking']['responseWitnessEvidence'];
  let observedAperture:Region|undefined,observedMarker:Rect|undefined,feedbackGeometrySafe=false;
  let displayAnchor:WorkerTrackingState['displayAnchor'];
  if (phase === 'cards') {
    const cards = detectNeutralCards(image);
    status = cards.status; nextAction = cards.nextAction;
    candidateCount = cards.evidence.candidateCount; cardCount = cards.cards.length;
    regions = cards.cards.map(card => mapRegion(card.region));
    neutralCardRegions=responseCardRegions(cards.cards,sx,sy);
    candidateRegions = (cards.evidence.candidateGeometry ?? []).slice(0, 12).map((candidate, index) => mapRegion({ id: `candidate-neutral-${index + 1}`, label: candidate.label, order: index, mode: 'solid', polygon: candidate.polygon, exclusions: [], background: null, layers: null, direction: null, operatorConfirmed: false, selectionMethod: 'autoDetected' }));
    const rejections = Object.fromEntries(Object.entries(cards.evidence.rejections ?? {}).slice(0, 16).filter(([, count]) => Number.isSafeInteger(count) && count >= 0).map(([key, count]) => [key.slice(0, 64), Math.min(count, 1_000_000)]));
    debug = { reason: cards.evidence.reason?.slice(0, 96), matchingTriplets: Math.min(cards.evidence.matchingTriplets ?? 0, 1_000_000), rejections };
  } else {
    const scene = detectLiveScene(image, request.expectedSequence, { requireReferenceIdentity: request.mode !== 'cameraMatch', ...(request.purpose==='response'?{purpose:'response' as const}:request.mode==='cameraMatch'?{displayLayout:'liveBands' as const}:{}) });
    const anchor=previous?.displayAnchor;
    const compatibleAnchor=anchor&&previous.mode===request.mode&&previous.purpose===request.purpose&&previous.fingerprint.width===frame.width&&previous.fingerprint.height===frame.height&&previous.fingerprint.analysisWidth===image.width&&previous.fingerprint.analysisHeight===image.height;
    if(request.mode==='cameraMatch'&&request.purpose!=='response'&&scene.marker&&scene.displayRegion&&scene.displayAperture){
      const m=scene.marker;
      const sameMarker=compatibleAnchor&&Math.max(Math.abs(m.x-anchor.marker.x),Math.abs(m.y-anchor.marker.y),Math.abs(m.width-anchor.marker.width),Math.abs(m.height-anchor.marker.height))<=1;
      const candidate=bounds(scene.displayAperture.polygon),old=anchor?bounds(anchor.aperture.polygon):null;
      const sameFootprint=sameMarker&&old&&Math.abs(candidate.x-old.x)<=2&&Math.abs(candidate.width-old.width)<=2&&candidate.y>=old.y-2&&candidate.y+candidate.height<=old.y+old.height+2;
      if(sameFootprint){
        displayAnchor=anchor;scene.displayAperture={...scene.displayAperture,polygon:anchor.aperture.polygon};scene.displayRegion={...scene.displayRegion,polygon:anchor.region.polygon};scene.apertureFeedbackSafe=true;
      }else if(scene.apertureFeedbackSafe){displayAnchor={aperture:scene.displayAperture,region:scene.displayRegion,marker:m};}
    }
    status = scene.status; nextAction = scene.nextAction;
    fabricCount = scene.fabricRegions.length; neutralCount = scene.neutralCandidates.length;
    markerCandidates = scene.evidence.markerCandidates; markerSequence = scene.evidence.markerSequence;
    candidateCount = fabricCount + neutralCount + Number(Boolean(scene.displayRegion));
    regions = [scene.displayRegion, ...scene.fabricRegions].filter((r): r is NonNullable<typeof r> => Boolean(r)).map(mapRegion);
    fabric = scene.fabricRegions;
    recognizedScreen = Boolean(scene.displayRegion);
    observedAperture=scene.displayAperture;observedMarker=scene.marker;feedbackGeometrySafe=Boolean(scene.displayAperture&&scene.apertureFeedbackSafe);
    debug={reason:scene.evidence.reason,markerSentinels:scene.evidence.markerSentinels,markerRejections:scene.evidence.markerRejections};
    if(request.purpose==='response'){
      const witness=scene.responseWitness;
      neutralCardRegions=responseCardRegions(witness?.card?[witness.card]:[],sx,sy);
      regions=[scene.displayRegion,witness?.card?.region].filter((r):r is NonNullable<typeof r>=>Boolean(r)).map(mapRegion);
      fabric=witness?.card?[witness.card.region]:[];
      if(witness){const {candidateCount,eligibleCount,ordering,rejections}=witness;responseWitnessEvidence={candidateCount,eligibleCount,ordering,rejections};}
      debug={reason:scene.evidence.reason,markerSentinels:scene.evidence.markerSentinels,markerRejections:scene.evidence.markerRejections};
    }else if(request.expectedSequence!==undefined)neutralCardRegions=responseCardRegions(detectNeutralCards(image).cards,sx,sy);
    if (scene.marker) marker = { x: scene.marker.x * sx, y: scene.marker.y * sy, width: scene.marker.width * sx, height: scene.marker.height * sy };
    // Mask the observed aperture, not only the smaller measurement ROI.
    if (scene.displayRegion) {
      const b = bounds((scene.displayAperture??scene.displayRegion).polygon), pad = Math.max(b.width, b.height) * 0.05;
      excluded.push([[b.x - pad, b.y - pad], [b.x + b.width + pad, b.y - pad], [b.x + b.width + pad, b.y + b.height + pad], [b.x - pad, b.y + b.height + pad]]);
    }
    if (scene.marker) {
      const b = scene.marker;
      excluded.push([[b.x - 3, b.y - 3], [b.x + b.width + 3, b.y - 3], [b.x + b.width + 3, b.y + b.height + 3], [b.x - 3, b.y + b.height + 3]]);
    }
    if(scene.displayAperture&&scene.marker){
      const a=bounds(scene.displayAperture.polygon),m=scene.marker;
      const left=Math.min(a.x,m.x)-4,right=Math.max(a.x+a.width,m.x+m.width)+4;
      excluded.push([[left,a.y-8],[right,a.y-8],[right,m.y+m.height+8],[left,m.y+m.height+8]]);
    }
  }
  const values = new Float32Array(32 * 24), mask = new Uint8Array(values.length);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) {
    const px = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / 32));
    const py = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / 24));
    const index = y * 32 + x, offset = (py * image.width + px) * 4;
    // Until recognized, the instructed right-hand display is conservatively masked.
    mask[index] = Number((request.purpose==='response'&&!fabric.some(r=>contains([px,py],r.polygon))) || (phase === 'scene' && !recognizedScreen && px >= image.width / 2) || excluded.some(p => contains([px, py], p)) || image.data[offset + 3] !== 255);
    values[index] = (image.data[offset] * 0.2126 + image.data[offset + 1] * 0.7152 + image.data[offset + 2] * 0.0722) / 255;
  }
  const fingerprint: Fingerprint = { values, mask, width: frame.width, height: frame.height, analysisWidth: image.width, analysisHeight: image.height, phase };
  const compatible = previous?.tracking.tracking.phase === phase && previous.mode === request.mode && previous.purpose===request.purpose && previous.fingerprint.width === frame.width && previous.fingerprint.height === frame.height && previous.fingerprint.analysisWidth === image.width && previous.fingerprint.analysisHeight === image.height && previous.tracking.tracking.frame.timeSource === frame.timeSource;
  let motionSamples = 0, difference = 0, changed = 0;
  const prior = previous?.fingerprint;
  if (compatible && prior) for (let i = 0; i < values.length; i++) {
    if (mask[i] || prior.mask[i]) continue;
    const delta = Math.abs(values[i] - prior.values[i]);
    difference += delta; changed += Number(delta > 0.045); motionSamples++;
  }
  const pixelMoving = motionSamples >= 24 && (difference / motionSamples > 0.025 || changed / motionSamples > 0.15);
  const priorAppearance=compatible?previous.appearance.filter(region=>{
    const b=bounds(region.polygon);
    return !observedAperture||!region.polygon.some(p=>contains(p,observedAperture!.polygon))&&!contains([b.x+b.width/2,b.y+b.height/2],observedAperture.polygon);
  }):[];
  const appearance = (priorAppearance.length ? priorAppearance : fabric).map(region => {
    const b = bounds(region.polygon), descriptor = new Float32Array(4 * 4 * 6);
    for (let cellY = 0; cellY < 4; cellY++) for (let cellX = 0; cellX < 4; cellX++) {
      const sum = [0, 0, 0], squares = [0, 0, 0]; let count = 0;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const px = Math.floor(b.x + (cellX + (x + 0.5) / 4) * b.width / 4), py = Math.floor(b.y + (cellY + (y + 0.5) / 4) * b.height / 4);
        if (!contains([px, py], region.polygon) || region.exclusions.some(p=>contains([px,py],p)) || excluded.some(p=>contains([px,py],p)) || px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
        for (let c = 0; c < 3; c++) { const value = image.data[(py * image.width + px) * 4 + c] / 255; sum[c] += value; squares[c] += value * value; } count++;
      }
      const index = (cellY * 4 + cellX) * 6;
      if (count) for (let c = 0; c < 3; c++) { descriptor[index + c] = sum[c] / count; descriptor[index + 3 + c] = Math.sqrt(Math.max(0, squares[c] / count - (sum[c] / count) ** 2)); }
    }
    return { id: region.id, polygon: region.polygon,exclusions:region.exclusions, descriptor };
  });
  const baseline = priorAppearance.length ? priorAppearance : appearance;
  const surfaceChanged = appearance.some(current => {
    const old = baseline.find(p => p.id === current.id);
    return old && current.descriptor.some((value, i) => Math.abs(value - old.descriptor[i]) > 0.045);
  });
  if(pixelMoving||surfaceChanged){displayAnchor=undefined;feedbackGeometrySafe=false;}
  const screen=regions.find(region=>region.id==='auto-display');
  const previewScreen=observedAperture??(screen?{...screen,polygon:screen.polygon.map(([x,y])=>[x/sx,y/sy] as Point),exclusions:screen.exclusions.map(p=>p.map(([x,y])=>[x/sx,y/sy] as Point))}:undefined);
  let neutralReferenceRgb: [number, number, number] | undefined;
  if (phase === 'scene' && request.mode === 'cameraMatch') {
    const cards = detectNeutralCards(image).cards;
    const middleCard = cards.find(c => c.role === 'middle') ?? cards[0];
    if (middleCard?.observedRgb) {
      neutralReferenceRgb = middleCard.observedRgb;
    }
  }
  // Geometry can remain visible without a marker, but must never echo A as fabric.
  const preview=request.purpose!=='response'&&phase==='scene'&&request.mode==='cameraMatch'&&(recognizedScreen||observedMarker)&&(request.expectedSequence===undefined||markerSequence===undefined||markerSequence===request.expectedSequence)?samplePreviewBands(image,fabric,previewScreen,neutralReferenceRgb):null;
  const samplingEvidence=previewScreen&&request.displayBands?inspectScreenBands(image,previewScreen,request.displayBands.bands):[];
  const rejectionReasons:PreviewRejectionReason[]=[];
  if(phase==='scene'&&request.mode==='cameraMatch'&&request.purpose!=='response'){
    if(markerSequence===undefined||!observedMarker)rejectionReasons.push('markerMissing');
    if(!observedAperture)rejectionReasons.push('screenApertureMissing');
    else if(!feedbackGeometrySafe)rejectionReasons.push('screenGeometryUncertain');
    if(request.displayBands&&markerSequence!==undefined&&request.displayBands.commandSequence!==markerSequence)rejectionReasons.push('markerMismatch');
    if(pixelMoving||surfaceChanged)rejectionReasons.push('cameraMoving');
    samplingEvidence.forEach(band=>rejectionReasons.push(...band.reasons));
    rejectionReasons.push(...preview?.targetRejectionReasons??[]);
  }
  const sampled=samplingEvidence.flatMap(band=>band.rgb&&!band.reasons.length?[{id:band.id,rgb:band.rgb,validPixels:band.validPixels,validBlocks:band.validBlocks,blockSpread:band.blockSpread,clippedRate:band.clippedRate}]:[]);
  const screenRoi=previewScreen?.polygon.map(([x,y])=>[x/image.width,y/image.height] as Point);
  const markerPixels=observedMarker&&markerSequence!==undefined?sampleMarker(image,observedMarker,{purpose:'analysisGeometry'}):undefined;
  const feedback=feedbackGeometrySafe&&!pixelMoving&&!surfaceChanged&&preview&&!preview.targetRejectionReasons.length&&screenRoi&&markerPixels&&request.displayBands&&request.displayBands.commandSequence===markerSequence?{markerSequence:markerSequence!,markerPixels,screenRoi,screenAppearanceBands:sampled}:undefined;
  const tracking = computeTracking(compatible ? previous.tracking : null, { phase, status, nextAction, regions, candidateRegions,neutralCardRegions,responseWitnessEvidence, debug,previewScreenRoi:screenRoi,previewMarkerCells:markerPixels,previewSamplingEvidence:samplingEvidence,previewFeedbackRejectionReasons:[...new Set(rejectionReasons)], ...(preview?{previewBands:preview.bands,previewMapping:preview.mapping,previewWarnings:preview.warnings}:{}),...(feedback?{previewFeedback:feedback}:{}),expectedSequence: request.expectedSequence, marker, frame, processingMs: performance.now() - started, pixelMoving, surfaceChanged, evidence: { candidateCount, cardCount, fabricCount, neutralCount, markerCandidates, motionSamples, ...(markerSequence === undefined ? {} : { markerSequence }) } });
  return { generation: request.generation, mode: request.mode,purpose:request.purpose, tracking, fingerprint, appearance: baseline,displayAnchor };
}

// Importable for deterministic tests, but handlers are installed only in a worker.
if (typeof document === 'undefined' && typeof self !== 'undefined' && 'postMessage' in self) {
  let state: WorkerTrackingState | null = null;
  self.onmessage = (event: MessageEvent<TrackingRequest>) => {
    const request = event.data;
    try {
      state = processTrackingFrame(request, state);
      self.postMessage({ id: request.id, generation: request.generation, frame: request.frame, tracking: state.tracking.tracking } satisfies TrackingResponse);
    } catch (error) {
      state = null;
      self.postMessage({ id: request.id, generation: request.generation, frame: request.frame, error: error instanceof Error ? error.message : 'Tracking detector failed' } satisfies TrackingResponse);
    }
  };
}
