import type { TraceLog,TraceEvent } from './trace';
import {sanitizeEvidenceSnapshot,sanitizeMarkerRejections} from './trace';

type Saved={accepted?:number;diagnosticId?:string};
type Status={state:'idle'|'saving'|'saved'|'retry';savedSequence:number;diagnosticId?:string};
export class DiagnosticSync {
  private saved=0;private timer?:ReturnType<typeof setInterval>;private inFlight=false;private state:Status['state']='idle';private id?:string;
  private listeners=new Set<()=>void>();
  private generation=-1;
  constructor(private log:TraceLog,private send:(body:{events:TraceEvent[]})=>Promise<Saved>){}
  start(){if(!this.timer)this.timer=setInterval(()=>void this.flush(),3000);}
  stop(){clearInterval(this.timer);this.timer=undefined;}
  subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  status():Status{return{state:this.state,savedSequence:this.saved,diagnosticId:this.id};}
  private notify(){for(const listener of this.listeners)listener();}
  async flush(){
    if(this.inFlight)return;
    if(this.generation!==this.log.generation()){this.generation=this.log.generation();this.saved=0;}
    const rows=this.log.entries();if(rows.length&&rows.at(-1)!.sequence<this.saved)this.saved=0;
    const pending=rows.filter(event=>event.sequence>this.saved);
    if(!pending.length)return;
    const events:TraceEvent[]=[];let bytes=32;
    for(const event of pending){const size=new TextEncoder().encode(JSON.stringify(event)).byteLength+2;if(events.length>=80||bytes+size>48000)break;events.push(event);bytes+=size;}
    if(!events.length)return;
    this.inFlight=true;this.state='saving';this.notify();
    const generation=this.generation;
    try{const result=await this.send({events});if(generation===this.log.generation())this.saved=events.at(-1)!.sequence;this.id=result.diagnosticId??this.id;this.state='saved';}
    catch{this.state='retry';}
    finally{this.inFlight=false;this.notify();}
  }
}

export function sendDiagnosticBatch(sessionId:string,token:string,body:{events:TraceEvent[]}):Promise<Saved>{
  // Do not use Api: tracing this upload would recursively create more trace events.
  const numbers=new Set('width height candidateCount cardCount fabricCount neutralCount markerCandidates motionSamples markerSequence expectedSequence regionCount presentedFrames mediaTime processingMs commandSequence elapsedMs bytes validationErrors sequence matchingTriplets analysisWidth analysisHeight bandCount retryAfterMs'.split(' '));
  const booleans=new Set('geometryStable moving pixelMoving surfaceChanged fresh stable retry'.split(' '));
  for(const key of 'analysisLongEdge frameCallbacks jobsStarted jobsCompleted timeouts resets retries attempt lastFrameAt lastCompletedAt lastReceiptAgeMs reportedMediaTime'.split(' '))numbers.add(key);
  const enums:Record<string,Set<string>>={role:new Set(['camera','display','server']),mode:new Set(['threeStage','catalogOnly','replay','cameraMatch']),method:new Set(['GET','POST','PATCH','DELETE','HEAD']),endpoint:new Set('session sessions camera-matches camera-matches/observe matches matches/observe camera-profile display-profile neutral-check reference measurements captures/analyze regions export conditions validations override images live-preview diagnostics diagnostics/summary other'.split(' ')),phase:new Set('reference neutral fabric display cameraMatch camera catalog capture preview standby cameraAppearancePreview unclassified'.split(' ')),status:new Set('ready waiting needsFraming moving unstable lost accepted rejected complete stopped pending error running paused connected disconnected needsNeutralCards unknown unclassified'.split(' ')),reason:new Set('operator_pause page_hidden camera_moved device_disconnected socket_disconnected camera_track_ended camera_selection_changed camera_settings_changed camera_controls_changed canvas_color_space_changed roi_changed automatic_run_interrupted profile_invalidated explicit_new_scene awaiting_devices device_joined backpressure fabric_target_drift conditions_changed display_conditions_changed camera_capabilities_changed display_capabilities_changed deleted unclassified'.split(' ')),name:new Set('Error AbortError TypeError NotAllowedError NotFoundError OverconstrainedError unclassified'.split(' ')),mapping:new Set(['screenAligned','orderedPreview']),code:new Set(['unclassified'])};
  const areas=new Set('camera tracking capture connection api workbench preview server diagnostics'.split(' '));
  enums.timeSource=new Set(['videoMediaTime','callbackClock']);
  for(const reason of 'slowProcessing workerTimeout lateDetection workerRetry callbackClock videoStarvation invalidFrame invalidPixels missingCardCandidates multipleCardSets cardSetGeometryOrBrightnessMismatch threeCardCandidates displayMarkerMissing displayApertureMissing unstableFrame'.split(' '))enums.reason.add(reason);
  const eventsAllowed=new Set('opened closed connecting request response rejected networkError geometry configuration baselineReset stage operation_start operation_complete operation_error measurement_stopped batch_complete update needsFraming submitted rendered skipped enabled disabled created expired pause resume joined disconnected session.state display.patch.set display.patch.rendered quality.alert match.iteration match.complete session.pause session.resume profile.invalidate camera.profile.ready reference.set measurement.submit heartbeat unclassified'.split(' '));
  eventsAllowed.add('previewOpened');eventsAllowed.add('captureStarted');
  enums.code=new Set('unclassified origin_mismatch invalid_token camera_token_required token_expired session_not_found body_too_large invalid_payload request_rate_limit session_request_rate_limit engine_busy fresh_actual_preview_frame_required preview_stream_cycle_required preview_stream_cycle_limit preview_rate_limit match_already_active command_history_limit marker_sequence_exhausted active_owned_camera_and_display_required fresh_rendered_command_required stale_command stale_render fabric_target_drift ambiguous_cards neutral_card_quality_rejected neutral_card_order_ambiguous live_neutral_cards_required neutral_card_geometry_changed co_captured_neutral_cards_required three_distinct_neutral_cards_required quality_rejected session_paused stage_order reused_actual_capture frame_reused measurement_invalidated native_video_roi_provenance_required settings_fingerprint_changed camera_match_target_quality_rejected camera_match_capture_quality_rejected reused_or_overlapping_video_frame duplicate_or_reused_capture diagnostics_disabled diagnostic_sequence_reused'.split(' '));
  for(const endpoint of 'response-profile response-profile/start response-profile/observe response-profile/invert'.split(' '))enums.endpoint.add(endpoint);
  for(const code of 'response_valid_profile_required response_out_of_support response_conditions_or_stream_changed response_server_step_required response_neutral_witness_drift response_normalized_rgb_validation_failed response_native_roi_changed response_relative_capture_quality_rejected preview_must_pause_before_response'.split(' '))enums.code.add(code);
  eventsAllowed.add('evidence');eventsAllowed.add('previewAccepted');numbers.add('markerSentinels');
  for(const code of 'capture_aborted capture_marker_mismatch capture_timeout capture_camera_unavailable capture_geometry_unavailable capture_canvas_unavailable capture_color_space_mismatch capture_settings_changed capture_geometry_unstable capture_unclassified capture_frozen_video_clock capture_frame_identity_unavailable preview_feedback_stale_command preview_feedback_context_changed preview_feedback_expired preview_feedback_pixel_count_exceeds_native_band'.split(' '))enums.code.add(code);
  for(const reason of 'cameraShadowClipped cameraHighlightClipped spatiallyMixed insufficientPixels insufficientBlocks invalidBand invalidImage markerMissing markerMismatch screenApertureMissing screenGeometryUncertain commandNotRendered geometryUnstable cameraMoving targetChanged colorSpaceMismatch bandLayoutMismatch responseWitnessSelected multipleResponseWitnesses responseWitnessMissing multipleBandStacks displayMarkerMismatch multipleDisplayMarkers'.split(' '))enums.reason.add(reason);
  const events=body.events.map(({sequence,elapsedMs,area,event,details})=>{
    const selected:Record<string,unknown>={};
    for(const [key,raw] of Object.entries(details)){
      if(key==='evidenceSnapshot'){const evidence=sanitizeEvidenceSnapshot(raw);if(evidence)selected[key]=evidence;continue;}
      if(key==='markerRejections'){const counts=sanitizeMarkerRejections(raw);if(counts)selected[key]=counts;continue;}
      const value=key==='phase'&&raw==='cards'?'neutral':key==='phase'&&raw==='scene'?'preview':raw;
      if(numbers.has(key)&&typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e12)selected[key]=value;
      else if(booleans.has(key)&&typeof value==='boolean')selected[key]=value;
      else if(key==='status'&&typeof value==='number'&&Number.isInteger(value)&&value>=100&&value<=599)selected[key]=value;
      else if(enums[key]&&typeof value==='string')selected[key]=enums[key].has(value)?value:key==='role'?'camera':key==='mode'?'cameraMatch':key==='method'?'GET':key==='endpoint'?'other':key==='mapping'?'orderedPreview':'unclassified';
    }
    return{sequence,elapsedMs,area:areas.has(area)?area:'diagnostics',event:eventsAllowed.has(event)?event:'unclassified',details:selected};
  });
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/diagnostics`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({events})}).then(async response=>{if(!response.ok)throw new Error('Diagnostic upload unavailable');return await response.json();});
}
