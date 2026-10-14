import {sanitizeEvidenceSnapshot,type EvidenceRgb,type EvidenceSnapshot} from './trace';

export function DiagnosticEvidencePanel({snapshots,currentCommandSequence}:{snapshots:EvidenceSnapshot[];currentCommandSequence?:number}){
  const safe=snapshots.map(sanitizeEvidenceSnapshot).filter((value):value is EvidenceSnapshot=>Boolean(value));
  const camera=safe.filter(value=>value.role==='camera').reduce<EvidenceSnapshot|undefined>((latest,value)=>!latest||(value.presentedFrames??-1)>=(latest.presentedFrames??-1)?value:latest,undefined);
  const display=safe.findLast(value=>value.role==='display'&&value.stage==='rendered'&&value.commandSequence===currentCommandSequence);
  const server=safe.findLast(value=>value.role==='server'&&value.commandSequence===currentCommandSequence);
  const rgb=(value?:EvidenceRgb)=>value?value.map(channel=>channel.toFixed(5)).join(', '):'اندازه‌گیری نشده';
  const pinned=currentCommandSequence!==undefined&&camera&&camera.stage==='sampled'&&camera.commandSequence===currentCommandSequence&&camera.markerSequence===currentCommandSequence&&camera.observedCommandSequence===currentCommandSequence&&display?.renderedProof==='twoAnimationFrames'&&display.colorSpace==='srgb'&&display.rgbEncoding==='encoded'&&camera.rgbEncoding==='encoded'&&camera.colorSpace==='srgb'&&(!camera.targetColorSpace||camera.targetColorSpace==='srgb')&&(!camera.observedColorSpace||camera.observedColorSpace==='srgb')&&!camera.rejectionReasons?.length&&camera.bands?.length===display.bands?.length&&camera.bands?.every(band=>{
    const painted=display.bands?.find(value=>value.bandIndex===band.bandIndex);
    return painted&&band.driveRgb&&painted.driveRgb&&band.driveRgb.every((channel,index)=>channel===painted.driveRgb![index])&&band.top===painted.top&&band.bottom===painted.bottom;
  });
  return <section className="live-diagnostics" aria-label="شواهد تشخیصی رنگ">
    <strong>فرمان A، رندر مرورگر و مشاهدهٔ B</strong>
    <p role="status">مرحلهٔ فعلی: {camera?.stage??server?.stage??display?.stage??'هنوز شواهد نرسیده'} · فرمان جاری: {currentCommandSequence??'ندارد'} · {camera?.rejectionReasons?.join(' / ')||'رد ثبت‌شده ندارد؛ این به معنی قبول اندازه‌گیری نیست'}</p>
    <p className="hint">RGB کدشده و RGB خطی جدا هستند؛ تأیید دو فریم فقط درخواست رندر است. دقت فیزیکی مستقل تأیید نشده است.</p>
    <div aria-label="فرمان و رنگ رندر A" dir="ltr">A: {display?'renderRequestOnly / srgb / encoded':'render evidence unavailable'}{display?.bands?.map(band=><p key={band.bandIndex}>Band {band.bandIndex+1} requested [{rgb(band.driveRgb)}] · CSS rounded [{rgb(band.renderedPaintRgb)}]</p>)}</div>
    <div aria-label="شواهد فریم B">B: فریم {camera?.presentedFrames??'نامعلوم'} · زمان خام {camera?.rawMediaTime??'نامعلوم'} · native {camera?.nativeWidth??'?'} × {camera?.nativeHeight??'?'} · analysis {camera?.analysisWidth??'?'} × {camera?.analysisHeight??'?'} · نشانگر {camera?.markerSequence??'خوانده نشده'}</div>
    <details><summary>هندسه و سلول‌های همان فریم</summary><pre dir="ltr" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({screenRoi:camera?.screenRoi??null,markerRoi:camera?.markerRoi??null,markerCells:camera?.markerCells??null,fabricRois:camera?.bands?.map(band=>({bandIndex:band.bandIndex,roi:band.roi??null})),domain:{colorSpace:camera?.colorSpace,rgbEncoding:camera?.rgbEncoding,targetColorSpace:camera?.targetColorSpace,observedColorSpace:camera?.observedColorSpace}},null,2)}</pre></details>
    <div style={{overflowX:'auto'}}><table><thead><tr><th>نوار</th><th>هدف دوربین، encoded</th><th>فرمان A، encoded</th><th>مشاهدهٔ صفحه B، encoded</th><th>کیفیت / علت</th></tr></thead><tbody>{camera?.bands?.map(band=><tr key={band.bandIndex}><td>{band.bandIndex+1}</td><td dir="ltr">{rgb(band.targetRgb)}</td><td dir="ltr">{rgb(band.driveRgb)}</td><td dir="ltr">{rgb(band.observedRgb)}</td><td>{band.quality?.status??'notAssessed'} · pixels {band.quality?.validPixels??'?'} · blocks {band.quality?.validBlocks??'?'} · {band.reasons?.join(' / ')??''}{pinned&&band.quality?.status==='accepted'&&band.targetRgb&&band.observedRgb&&<p aria-label={`اختلاف RGB کدشده نوار ${band.bandIndex+1}`} dir="ltr">encoded RGB difference [{rgb(band.observedRgb.map((channel,index)=>channel-band.targetRgb![index]) as EvidenceRgb)}]</p>}</td></tr>)}</tbody></table></div>
    {!pinned&&<p>اختلاف اندازه‌گیری نمایش داده نمی‌شود: رندر A، نشانگر فرمان جاری، همان فریم B و کیفیت معتبر باید با هم ثبت شوند.</p>}
    {server?.bands?.some(band=>band.residualBefore!==undefined)&&<p dir="ltr">Server residualBefore ({server.residualMetric??'unclassified'}): {server.bands.map(band=>band.residualBefore===undefined?'not measured':band.residualBefore.toFixed(5)).join(' / ')}. No measured-after claim.</p>}
  </section>;
}
