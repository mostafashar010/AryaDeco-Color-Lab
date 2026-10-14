import{useEffect,useRef,useState}from'react';
import type{Api}from'./session';
import type{LiveTracking}from'./liveTracking';

export type DebugFrame={blob:Blob;metadata:{presentedFrames:number;mediaTime:number;width:number;height:number;imageWidth:number;imageHeight:number;trackingPresentedFrames?:number;trackingRawMediaTime?:number;trackingMatchedFrame:boolean;phase?:string;status?:string;candidateCount?:number;cardCount?:number;markerCandidates?:number;fabricCount?:number}};
type DebugStatus={enabled:boolean;debugId:string;expiresAt:string;captureIntervalMs:number;maxFrames:number;frameCount?:number};
export function LiveDebugPanel({api,cameraActive,capture}:{api:Api;cameraActive:boolean;capture:()=>Promise<DebugFrame>}){
  const[consent,setConsent]=useState(false),[active,setActive]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('تصویری ارسال نشده است.');
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null),generation=useRef(0),enabled=useRef(false),currentApi=useRef(api);
  currentApi.current=api;
  const currentCapture=useRef(capture);currentCapture.current=capture;
  const clearTimer=()=>{if(timer.current)clearTimeout(timer.current);timer.current=null;};
  const stop=async()=>{
    generation.current++;clearTimer();const wasEnabled=enabled.current;enabled.current=false;setActive(false);setBusy(false);
    if(wasEnabled){try{await currentApi.current.post('live-debug',{enabled:false,consent:false});setMessage('عیب‌یابی متوقف و تصاویر همین جلسه پاک شدند.');}catch{setMessage('ارسال متوقف شد؛ پاک‌سازی سرور تأیید نشد. تصاویر حداکثر تا پایان مهلت محدود باقی می‌مانند.');}}
  };
  useEffect(()=>{
    if(!cameraActive)void stop();
    const hidden=()=>{if(document.hidden)void stop();};document.addEventListener('visibilitychange',hidden);
    return()=>{document.removeEventListener('visibilitychange',hidden);generation.current++;clearTimer();if(enabled.current){enabled.current=false;void currentApi.current.post('live-debug',{enabled:false,consent:false}).catch(()=>{});}};
  },[cameraActive,api.sessionId]);
  const start=async()=>{
    if(!cameraActive||!consent||enabled.current)return;const epoch=++generation.current;setBusy(true);
    try{
      const status=await api.post<DebugStatus>('live-debug',{enabled:true,consent:true});
      if(epoch!==generation.current){void api.post('live-debug',{enabled:false,consent:false}).catch(()=>{});return;}
      if(status.enabled!==true)throw new Error('سرور فعال‌شدن اشتراک‌گذاری تصویری را تأیید نکرد.');
      enabled.current=true;setActive(true);setBusy(false);setMessage(`اشتراک‌گذاری تصویر فعال است؛ شناسه ${status.debugId}`);
      const expiry=Date.parse(status.expiresAt),deadline=Math.min(Number.isFinite(expiry)?expiry:Date.now()+300000,Date.now()+300000);
      const loop=async()=>{
        if(!enabled.current||epoch!==generation.current)return;
        if(Date.now()>=deadline){await stop();return;}
        try{
          const frame=await currentCapture.current();if(!enabled.current||epoch!==generation.current)return;
          const metadata={...frame.metadata,...(frame.metadata.phase!==undefined?{phase:frame.metadata.phase==='cards'?'neutral':frame.metadata.phase==='scene'?'preview':'unclassified'}:{})};
          const form=new FormData();form.append('file',frame.blob,'camera-debug.jpg');form.append('metadata',JSON.stringify(metadata));
          const saved=await currentApi.current.request<{frameCount?:number}>(`/api/sessions/${encodeURIComponent(currentApi.current.sessionId)}/live-debug/frames`,'POST',form);
          if(!enabled.current||epoch!==generation.current)return;
          const correlation=metadata.trackingMatchedFrame?'نتیجهٔ ردیابی متعلق به همین فریم تصویر است.':metadata.trackingPresentedFrames===undefined?'برای این تصویر نتیجهٔ ردیابی وجود ندارد؛ وضعیت و شمارش اشیا ثبت نشد.':'فریم تصویر با فریم ردیابی یکسان نیست؛ وضعیت و شمارش قبلی به این تصویر نسبت داده نشد.';
          setMessage(`تصویر عیب‌یابی روی لپ‌تاپ ذخیره شد؛ شناسه ${status.debugId} · ${saved.frameCount??1} فریم محدود. ${correlation} اکنون مشکل را در همان کادر تکرار کنید.`);
          timer.current=setTimeout(()=>void loop(),Math.max(4000,status.captureIntervalMs));
        }catch(error){await stop();setMessage(`ارسال تصویر انجام نشد: ${error instanceof Error?error.message:'خطای دریافت قاب'}`);}
      };
      void loop();
    }catch(error){if(epoch===generation.current){setBusy(false);setMessage(error instanceof Error?error.message:'عیب‌یابی تصویری فعال نشد.');}}
  };
  return<section className="panel" aria-label="عیب‌یابی زنده با تصویر"><h3>عیب‌یابی زنده با تصویر</h3><p>فقط روی همین لپ‌تاپ: تصویر کوچک کادر دوربین هر چند ثانیه ذخیره می‌شود تا مشکل قابل بررسی باشد. حداکثر ۸ تصویر و ۵ دقیقه؛ برای اندازه‌گیری رنگ استفاده نمی‌شود. اطلاعات شخصی را از قاب بیرون بگذارید.</p><label className="check"><input type="checkbox" checked={consent} disabled={active||busy} onChange={event=>setConsent(event.target.checked)}/>با ذخیرهٔ موقت تصویر دوربین برای عیب‌یابی موافقم</label><div className="toolbar"><button disabled={!cameraActive||!consent||active||busy} onClick={()=>void start()}>شروع عیب‌یابی تصویری زنده</button><button disabled={!active&&!busy} onClick={()=>void stop()}>توقف و پاک‌کردن تصاویر عیب‌یابی</button></div><p role="status" style={active?{color:'#ffd684'}:undefined}>{message}</p></section>;
}

export function captureDebugFrame(video:HTMLVideoElement,tracking:LiveTracking|null):Promise<DebugFrame>{
  if(!video.videoWidth||!video.videoHeight||video.readyState<2)return Promise.reject(new Error('ابتدا دوربین را باز کنید تا کادر زنده دیده شود.'));
  return new Promise((resolve,reject)=>{
    let handle=0;const timeout=setTimeout(()=>{video.cancelVideoFrameCallback?.(handle);reject(new Error('فریم تازهٔ دوربین برای عیب‌یابی نرسید.'));},4000);
    handle=video.requestVideoFrameCallback((_now,frame)=>{
      clearTimeout(timeout);
      try{
        const width=video.videoWidth,height=video.videoHeight,canvas=document.createElement('canvas'),factor=Math.min(1,640/Math.max(width,height));canvas.width=Math.max(1,Math.round(width*factor));canvas.height=Math.max(1,Math.round(height*factor));
        const context=canvas.getContext('2d',{colorSpace:'srgb'});if(!context)throw new Error('کادر تصویری در دسترس نیست.');context.drawImage(video,0,0,canvas.width,canvas.height);
        // The tracker may use a callback-derived clock; compare only the reported native time.
        const trackingRawMediaTime=tracking?.frame.reportedMediaTime??(tracking?.frame.timeSource==='callbackClock'?undefined:tracking?.frame.mediaTime);
        const trackingMatchedFrame=Boolean(tracking&&tracking.frame.presentedFrames===frame.presentedFrames&&trackingRawMediaTime===frame.mediaTime&&tracking.frame.width===width&&tracking.frame.height===height);
        const metadata:DebugFrame['metadata']={presentedFrames:frame.presentedFrames,mediaTime:frame.mediaTime,width,height,imageWidth:canvas.width,imageHeight:canvas.height,trackingMatchedFrame,...(tracking?{trackingPresentedFrames:tracking.frame.presentedFrames,...(trackingRawMediaTime!==undefined?{trackingRawMediaTime}:{})}:{}),...(trackingMatchedFrame&&tracking?{phase:tracking.phase,status:tracking.status,candidateCount:tracking.evidence.candidateCount,cardCount:tracking.evidence.cardCount,markerCandidates:tracking.evidence.markerCandidates,fabricCount:tracking.evidence.fabricCount}:{})};
        canvas.toBlob(blob=>{if(!blob||blob.size>300*1024){reject(new Error('تصویر عیب‌یابی ساخته نشد یا از سقف حجم عبور کرد.'));return;}resolve({blob,metadata});},'image/jpeg',.8);
      }catch(error){reject(error);}
    });
  });
}
