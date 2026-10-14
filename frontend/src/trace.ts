export type TraceEvent = { sequence:number; elapsedMs:number; at:string; area:string; event:string; details:Record<string,unknown> };
export type EvidenceRgb=[number,number,number];
export type EvidenceBand={bandIndex:number;top?:number;bottom?:number;targetRgb?:EvidenceRgb;driveRgb?:EvidenceRgb;renderedPaintRgb?:EvidenceRgb;observedRgb?:EvidenceRgb;roi?:[number,number][];quality?:{status:'accepted'|'rejected'|'notAssessed'|'previewOnly'|'measured';validPixels?:number;validBlocks?:number;blockSpread?:number;clippedRate?:number;shadowClippedRate?:number;highlightClippedRate?:number};residualBefore?:number;reasons?:string[]};
export type EvidenceSnapshot={role:'camera'|'display'|'server';stage:'intended'|'rendered'|'decoded'|'sampled'|'feedbackAccepted'|'rejected';commandSequence?:number;markerSequence?:number;observedCommandSequence?:number;presentedFrames?:number;rawMediaTime?:number;nativeWidth?:number;nativeHeight?:number;analysisWidth?:number;analysisHeight?:number;mapping?:'screenAligned'|'orderedPreview';layout?:'single'|'group'|'liveBands';colorSpace?:'srgb'|'display-p3';targetColorSpace?:'srgb'|'display-p3';driveColorSpace?:'srgb'|'display-p3';observedColorSpace?:'srgb'|'display-p3';rgbEncoding?:'encoded'|'linear';displayDriveRgb?:EvidenceRgb;renderedPaintRgb?:EvidenceRgb;screenRoi?:[number,number][];markerRoi?:[number,number][];markerCells?:EvidenceRgb[];bands?:EvidenceBand[];renderedProof?:'twoAnimationFrames';status?:'renderRequestOnly'|'previewOnly'|'measured'|'accepted'|'rejected'|'notAssessed';physicalAccuracyVerified?:false;residualMetric?:'linearCameraRgb';rejectionReasons?:string[]};
export const evidenceReasons=new Set('cameraShadowClipped cameraHighlightClipped spatiallyMixed insufficientPixels insufficientBlocks invalidBand invalidImage markerMissing markerMismatch screenApertureMissing screenGeometryUncertain geometryUnstable cameraMoving bandLayoutMismatch commandNotRendered targetChanged colorSpaceMismatch'.split(' '));
const markerRejectionKeys=new Set('sentinelShapeOrResolution ambiguousCells stripHeightSupport nativeSequenceMismatch nativeCellAmbiguity nativeSentinelEdges analysisCellResolution borderedCellAmbiguity borderedRowSupport markerBorderIncomplete'.split(' '));
export function sanitizeMarkerRejections(value:unknown):Record<string,number>|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  return Object.fromEntries(Object.entries(value).filter(([key,count])=>markerRejectionKeys.has(key)&&typeof count==='number'&&Number.isSafeInteger(count)&&count>=0&&count<=1e9));
}
export function sanitizeEvidenceSnapshot(value:unknown):EvidenceSnapshot|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const input=value as Record<string,unknown>;
  if(!['camera','display','server'].includes(String(input.role))||!['intended','rendered','decoded','sampled','feedbackAccepted','rejected'].includes(String(input.stage)))return;
  const output:Record<string,unknown>={role:input.role,stage:input.stage};
  const number=(v:unknown,max:number,integer=false)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max&&(!integer||Number.isSafeInteger(v));
  const rgb=(v:unknown):v is EvidenceRgb=>Array.isArray(v)&&v.length===3&&v.every(channel=>number(channel,1));
  const polygon=(v:unknown)=>Array.isArray(v)&&v.length>=3&&v.length<=8&&v.every(point=>Array.isArray(point)&&point.length===2&&point.every(coordinate=>number(coordinate,1)));
  const reasons=(v:unknown,max:number)=>Array.isArray(v)?v.filter(reason=>typeof reason==='string'&&evidenceReasons.has(reason)).slice(0,max):undefined;
  for(const key of ['commandSequence','markerSequence','observedCommandSequence'])if(number(input[key],0xffffff,true)&&(input[key] as number)>0)output[key]=input[key];
  if(number(input.presentedFrames,1e9,true))output.presentedFrames=input.presentedFrames;
  if(number(input.rawMediaTime,1e12))output.rawMediaTime=input.rawMediaTime;
  for(const key of ['nativeWidth','nativeHeight','analysisWidth','analysisHeight'])if(number(input[key],12000,true)&&(input[key] as number)>0)output[key]=input[key];
  const enums:Record<string,string[]>={mapping:['screenAligned','orderedPreview'],layout:['single','group','liveBands'],colorSpace:['srgb','display-p3'],targetColorSpace:['srgb','display-p3'],driveColorSpace:['srgb','display-p3'],observedColorSpace:['srgb','display-p3'],rgbEncoding:['encoded','linear'],renderedProof:['twoAnimationFrames'],status:['renderRequestOnly','previewOnly','measured','accepted','rejected','notAssessed'],residualMetric:['linearCameraRgb']};
  for(const [key,values]of Object.entries(enums))if(typeof input[key]==='string'&&values.includes(input[key] as string))output[key]=input[key];
  if(input.physicalAccuracyVerified===false)output.physicalAccuracyVerified=false;
  const domain=Boolean(output.colorSpace&&output.rgbEncoding);
  for(const key of ['displayDriveRgb','renderedPaintRgb'])if(domain&&rgb(input[key]))output[key]=[...(input[key] as EvidenceRgb)];
  for(const key of ['screenRoi','markerRoi'])if(polygon(input[key]))output[key]=structuredClone(input[key]);
  if(domain&&Array.isArray(input.markerCells)&&input.markerCells.slice(0,28).every(rgb))output.markerCells=input.markerCells.slice(0,28).map(cell=>[...cell]);
  const indices=new Set<number>();
  if(Array.isArray(input.bands))output.bands=input.bands.slice(0,32).flatMap(raw=>{
    if(!raw||typeof raw!=='object'||!number(raw.bandIndex,31,true)||indices.has(raw.bandIndex))return[];indices.add(raw.bandIndex);
    const band:Record<string,unknown>={bandIndex:raw.bandIndex};
    if(number(raw.top,1)&&number(raw.bottom,1)&&raw.top<raw.bottom){band.top=raw.top;band.bottom=raw.bottom;}
    for(const key of ['targetRgb','driveRgb','renderedPaintRgb','observedRgb'])if(domain&&rgb(raw[key]))band[key]=[...raw[key]];
    if(polygon(raw.roi))band.roi=structuredClone(raw.roi);
    if(output.residualMetric&&number(raw.residualBefore,2))band.residualBefore=raw.residualBefore;
    const selected=reasons(raw.reasons,8);if(selected?.length)band.reasons=selected;
    if(raw.quality&&typeof raw.quality==='object'){
      const quality:Record<string,unknown>={};
      if(['accepted','rejected','notAssessed','previewOnly','measured'].includes(raw.quality.status))quality.status=raw.quality.status;
      for(const key of ['validPixels','validBlocks'])if(number(raw.quality[key],key==='validPixels'?1e8:8192,true))quality[key]=raw.quality[key];
      for(const key of ['blockSpread','clippedRate','shadowClippedRate','highlightClippedRate'])if(number(raw.quality[key],1))quality[key]=raw.quality[key];
      if(quality.status)band.quality=quality;
    }
    return[band];
  });
  const rejected=reasons(input.rejectionReasons,16);if(rejected?.length)output.rejectionReasons=rejected;
  return output as EvidenceSnapshot;
}
export function diagnosticErrorCode(error:unknown):string{
  const value=error as {code?:unknown;name?:unknown;message?:unknown}|null;
  const codes=new Set('capture_aborted capture_marker_mismatch capture_timeout capture_camera_unavailable capture_geometry_unavailable capture_canvas_unavailable capture_color_space_mismatch capture_settings_changed capture_geometry_unstable capture_unclassified preview_feedback_stale_command preview_feedback_context_changed preview_feedback_expired response_valid_profile_required response_out_of_support response_conditions_or_stream_changed response_server_step_required response_neutral_witness_drift response_normalized_rgb_validation_failed response_native_roi_changed response_relative_capture_quality_rejected'.split(' '));
  if(typeof value?.code==='string'&&codes.has(value.code))return value.code;
  if(value?.name==='AbortError')return'capture_aborted';
  const known:Record<string,string>={
    'نمونه‌برداری به دلیل توقف جلسه لغو شد.':'capture_aborted',
    'نشانگر فیزیکی مربوط به فرمان جاری نیست.':'capture_marker_mismatch',
    'دریافت ۱۰ فریم تازه در مهلت مجاز انجام نشد.':'capture_timeout',
    'تنظیمات دوربین حین برداشت تغییر کرد.':'capture_settings_changed',
    'دوربین واقعی را ابتدا فعال کنید.':'capture_camera_unavailable',
    'دوربین یا ناحیه آماده نیست.':'capture_camera_unavailable',
    'ROI نشانگر فیزیکی انتخاب نشده است.':'capture_geometry_unavailable',
    'سه تشخیص پایدار از قاب تازه لازم است؛ کادر را ثابت کنید و دوباره شروع کنید.':'capture_geometry_unstable',
    'فضای رنگ بازگشتی canvas با درخواست یکی نیست.':'capture_color_space_mismatch',
    'مسیر canvas در دسترس نیست.':'capture_canvas_unavailable',
    'مرورگر زمان ویدئو را ثابت گزارش می‌کند؛ پیش‌نمایش زنده کار می‌کند اما برداشت دقیق در این مسیر تأیید نمی‌شود. از نمایش زندهٔ کالیته استفاده کنید.':'capture_frozen_video_clock',
    'شناسهٔ واقعی ویدئو تازه و افزایشی نیست.':'capture_frame_identity_unavailable',
    'فریم ویدئو یکتا در این مرورگر قابل تأیید نیست.':'capture_frame_identity_unavailable',
    'ROI نشانگر باید داخل تصویر و دارای وضوح کافی باشد.':'capture_geometry_unavailable',
    'کنتراست یا هندسهٔ نشانگر قابل تأیید نیست.':'capture_marker_mismatch',
    'خانهٔ مبهم در نشانگر؛ نمونه‌برداری متوقف شد.':'capture_marker_mismatch',
    'خانهٔ نشانگر بدون پیکسل است.':'capture_marker_mismatch',
    'دادهٔ نشانگر نامعتبر است.':'capture_marker_mismatch',
    'نشانگر در ردیف‌های تصویر یکسان نیست.':'capture_marker_mismatch',
    'نشانگر باید دست‌کم دو ردیف مستقل داشته باشد.':'capture_marker_mismatch',
  };
  return typeof value?.message==='string'?known[value.message]??'capture_unclassified':'capture_unclassified';
}
const safeText=(value:string)=>value.slice(0,1200).replace(/(?:data:image\/[^\s]+)|https?:\/\/\S+|["']?(?:token|cameraToken|displayToken|authorization|cookie|secret|password|sessionid)["']?\s*[:=]\s*["']?[^\s,;}"']+["']?|Bearer\s+\S+|private[-_][\w-]+/gi,'[redacted]').slice(0,400);
const allowedKeys=new Set('message width height candidateCount cardCount fabricCount neutralCount markerCandidates motionSamples markerSequence geometryStable moving pixelMoving surfaceChanged fresh expectedSequence phase status stable frameCounts regionCount presentedFrames mediaTime processingMs commandSequence elapsedMs method endpoint bytes code validationErrors role reason retry mode name event sequence settings reportedSettings evidence rejections matchingTriplets analysisWidth analysisHeight touchesFrameEdge tooSmall tooLarge nonRectangularOrOccluded shapeOrSize nonuniformInteriorOrGlare'.split(' '));
allowedKeys.add('bandCount');
for(const key of 'analysisLongEdge frameCallbacks jobsStarted jobsCompleted timeouts resets retries attempt lastFrameAt lastCompletedAt lastReceiptAgeMs reportedMediaTime timeSource'.split(' '))allowedKeys.add(key);
function clean(value:unknown,depth=0,budget={remaining:4096}):unknown {
  if(depth>3||budget.remaining<1) return '[bounded]';
  if(typeof value==='string'){const text=safeText(value).slice(0,Math.max(0,budget.remaining));budget.remaining-=text.length;return text;}
  if(typeof value==='number') return Number.isFinite(value)?value:null;
  if(value===null||typeof value==='boolean') return value;
  if(Array.isArray(value)) return value.slice(0,32).map(item=>{budget.remaining-=16;return clean(item,depth+1,budget);});
  if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).slice(0,48).flatMap(([key,item])=>{
    if(depth===0&&key==='evidenceSnapshot'){const evidence=sanitizeEvidenceSnapshot(item);return evidence?[[key,evidence]]:[];}
    if(key==='markerRejections'){const counts=sanitizeMarkerRejections(item);return counts?[[key,counts]]:[];}
    if(key==='markerSentinels')return typeof item==='number'&&Number.isSafeInteger(item)&&item>=0&&item<=1e9?[[key,item]]:[];
    if(!allowedKeys.has(key))return[];budget.remaining-=key.length+16;return[[key,clean(item,depth+1,budget)]];
  }));
  return null;
}
export class TraceLog {
  private rows:TraceEvent[]=[];
  private started:number;
  private sequence=0;
  private dropped=0;
  private epoch=0;
  private listeners=new Set<()=>void>();
  constructor(private clock:()=>number=()=>performance.now()){this.started=this.clock();}
  add(area:string,event:string,details:Record<string,unknown>={}) {
    this.rows.push({sequence:++this.sequence,elapsedMs:Math.round(this.clock()-this.started),at:new Date().toISOString(),area:safeText(area).slice(0,64),event:safeText(event).slice(0,64),details:clean(details) as Record<string,unknown>});
    if(this.rows.length>300){this.rows.shift();this.dropped++;}
    for(const listener of this.listeners)listener();
  }
  entries(){return this.rows.map(row=>({...row,details:structuredClone(row.details)}));}
  subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  generation(){return this.epoch;}
  clear(){this.rows=[];this.dropped=0;this.epoch++;this.started=this.clock();for(const listener of this.listeners)listener();}
  toJSON(){return JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),scope:'localSoftwareDiagnosticsNotPhysicalAccuracy',containsImages:false,credentialsPolicy:'knownSecretFieldsExcludedFreeTextNotAttested',droppedEvents:this.dropped,events:this.entries()},null,2);}
}
export const diagnosticTrace=new TraceLog();
