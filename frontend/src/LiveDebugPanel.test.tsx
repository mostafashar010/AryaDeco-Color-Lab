import{describe,it,expect,vi,afterEach}from'vitest';
import{render,screen,fireEvent,waitFor,act}from'@testing-library/react';
import{LiveDebugPanel,captureDebugFrame}from'./LiveDebugPanel';
import type{Api}from'./session';
import type{LiveTracking}from'./liveTracking';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function inputs(){return{api:{sessionId:'s',post:vi.fn(async()=>({enabled:true,debugId:'debug-test',expiresAt:new Date(Date.now()+300000).toISOString(),captureIntervalMs:3000,maxFrames:8})),request:vi.fn(async()=>({frameCount:1}))}as unknown as Api,capture:vi.fn(async()=>({blob:new Blob(['test'],{type:'image/jpeg'}),metadata:{presentedFrames:1,mediaTime:0,width:640,height:480,imageWidth:640,imageHeight:480,trackingPresentedFrames:1,trackingRawMediaTime:0,trackingMatchedFrame:true,phase:'cards',status:'needsFraming',candidateCount:2,cardCount:0,markerCandidates:0,fabricCount:0}})),cameraActive:true};}
describe('explicit opt-in live image debugging',()=>{
  it('sends no frames before consent and shows exactly what is shared',()=>{
    const input=inputs();render(<LiveDebugPanel {...input}/>);
    expect(screen.getByRole('button',{name:'شروع عیب‌یابی تصویری زنده'})).toBeDisabled();
    expect(screen.getByText(/فقط روی همین لپ‌تاپ/)).toBeVisible();
    expect(input.capture).not.toHaveBeenCalled();expect(input.api.post).not.toHaveBeenCalled();
  });
  it('uploads the real camera frame only after opt-in and stops with server deletion',async()=>{
    const input=inputs();render(<LiveDebugPanel {...input}/>);
    fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'شروع عیب‌یابی تصویری زنده'}));
    await waitFor(()=>expect(input.api.request).toHaveBeenCalledOnce());
    expect(input.api.post).toHaveBeenCalledWith('live-debug',{enabled:true,consent:true});
    const upload=vi.mocked(input.api.request).mock.calls[0];expect(upload[0]).toBe('/api/sessions/s/live-debug/frames');
    expect(upload[2]).toBeInstanceOf(FormData);
    expect(JSON.parse((upload[2]as FormData).get('metadata')as string).phase).toBe('neutral');
    expect(screen.getByRole('status')).toHaveTextContent('debug-test');
    fireEvent.click(screen.getByRole('button',{name:'توقف و پاک‌کردن تصاویر عیب‌یابی'}));
    await waitFor(()=>expect(input.api.post).toHaveBeenCalledWith('live-debug',{enabled:false,consent:false}));
  });
  it('keeps only one capture in flight and does not upload it after camera closes',async()=>{
    vi.useFakeTimers();let release!:(value:Awaited<ReturnType<ReturnType<typeof inputs>['capture']>>)=>void;
    const input=inputs();input.capture.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
    const view=render(<LiveDebugPanel {...input}/>);
    await act(async()=>{fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'شروع عیب‌یابی تصویری زنده'}));});
    await act(()=>vi.advanceTimersByTimeAsync(10000));expect(input.capture).toHaveBeenCalledOnce();
    view.rerender(<LiveDebugPanel {...input} cameraActive={false}/>);
    await act(async()=>{release({blob:new Blob(),metadata:{presentedFrames:1,mediaTime:0,width:640,height:480,imageWidth:640,imageHeight:480,trackingPresentedFrames:1,trackingRawMediaTime:0,trackingMatchedFrame:true,phase:'cards',status:'ready',candidateCount:3,cardCount:3,markerCandidates:0,fabricCount:0}});});
    expect(input.api.request).not.toHaveBeenCalled();
  });
});

function trackingFrame():LiveTracking{return{phase:'cards',status:'ready',nextAction:'',regions:[],marker:null,evidence:{candidateCount:3,cardCount:3,markerCandidates:0,fabricCount:0,neutralCount:3,motionSamples:0},frame:{presentedFrames:10,mediaTime:1,width:1920,height:1080},processingMs:0,geometryStable:true,moving:false};}
function debugVideo(){
  const video=document.createElement('video');let callback!:VideoFrameRequestCallback;
  Object.defineProperties(video,{videoWidth:{value:1920},videoHeight:{value:1080},readyState:{value:2}});
  video.requestVideoFrameCallback=vi.fn(cb=>{callback=cb;return 1;});video.cancelVideoFrameCallback=vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn()}as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(cb=>cb(new Blob(['frame'],{type:'image/jpeg'})));
  return{video,present:(presentedFrames:number,mediaTime:number)=>callback(0,{presentedFrames,mediaTime}as VideoFrameCallbackMetadata)};
}
describe('debug image frame correlation',()=>{
  it('keeps capture frame 11 separate from tracking frame 10 and omits old detection results',async()=>{
    const input=debugVideo(),tracking=trackingFrame();const pending=captureDebugFrame(input.video,tracking);input.present(11,1.1);
    const{metadata}=await pending;
    expect(metadata).toMatchObject({presentedFrames:11,mediaTime:1.1,width:1920,height:1080,imageWidth:640,imageHeight:360,trackingPresentedFrames:10,trackingRawMediaTime:1,trackingMatchedFrame:false});
    for(const key of ['phase','status','candidateCount','cardCount','markerCandidates','fabricCount'])expect(metadata).not.toHaveProperty(key);
    expect(tracking.frame.presentedFrames).toBe(10);
  });
  it('keeps exact same-frame counts including zero and uses raw zero instead of callback clock',async()=>{
    const input=debugVideo(),tracking=trackingFrame();tracking.frame={...tracking.frame,mediaTime:123,timeSource:'callbackClock',reportedMediaTime:0};
    const pending=captureDebugFrame(input.video,tracking);input.present(10,0);
    expect((await pending).metadata).toEqual({presentedFrames:10,mediaTime:0,width:1920,height:1080,imageWidth:640,imageHeight:360,trackingPresentedFrames:10,trackingRawMediaTime:0,trackingMatchedFrame:true,phase:'cards',status:'ready',candidateCount:3,cardCount:3,markerCandidates:0,fabricCount:0});
  });
  it.each(['rawTime','dimensions','unreportedClock']as const)('withholds detection when presented count matches but %s identity does not',async(mismatch)=>{
    const input=debugVideo(),tracking=trackingFrame();
    if(mismatch==='rawTime')tracking.frame.mediaTime=2;
    if(mismatch==='dimensions')tracking.frame.width=1280;
    if(mismatch==='unreportedClock')tracking.frame.timeSource='callbackClock';
    const pending=captureDebugFrame(input.video,tracking);input.present(10,1);
    const{metadata}=await pending;expect(metadata.trackingMatchedFrame).toBe(false);expect(metadata).not.toHaveProperty('status');expect(metadata).not.toHaveProperty('candidateCount');
    if(mismatch==='unreportedClock')expect(metadata).not.toHaveProperty('trackingRawMediaTime');
  });
  it('distinguishes no tracking from a detector reporting zero objects',async()=>{
    const input=debugVideo(),pending=captureDebugFrame(input.video,null);input.present(11,0);
    const{metadata}=await pending;expect(metadata).toEqual({presentedFrames:11,mediaTime:0,width:1920,height:1080,imageWidth:640,imageHeight:360,trackingMatchedFrame:false});
  });
  it.each([true,false])('uploads and displays explicit correlation when tracking exists: matched=%s',async(matched)=>{
    const input=inputs(),native=debugVideo(),pending=captureDebugFrame(native.video,trackingFrame());native.present(matched?10:11,1);
    const frame=await pending;render(<LiveDebugPanel {...input} capture={async()=>frame}/>);
    fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'شروع عیب‌یابی تصویری زنده'}));
    await waitFor(()=>expect(input.api.request).toHaveBeenCalledOnce());
    const uploaded=JSON.parse((vi.mocked(input.api.request).mock.calls[0][2]as FormData).get('metadata')as string);
    expect(uploaded.trackingMatchedFrame).toBe(matched);
    if(matched){expect(uploaded.phase).toBe('neutral');expect(uploaded.status).toBe('ready');expect(screen.getByRole('status')).toHaveTextContent('نتیجهٔ ردیابی متعلق به همین فریم تصویر است');}
    else{expect(uploaded).not.toHaveProperty('phase');expect(uploaded).not.toHaveProperty('status');expect(uploaded).not.toHaveProperty('cardCount');expect(screen.getByRole('status')).toHaveTextContent('فریم تصویر با فریم ردیابی یکسان نیست');}
  });
  it('shows no-tracking text rather than a zero-object detection',async()=>{
    const input=inputs(),native=debugVideo(),pending=captureDebugFrame(native.video,null);native.present(1,0);
    const frame=await pending;render(<LiveDebugPanel {...input} capture={async()=>frame}/>);
    fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'شروع عیب‌یابی تصویری زنده'}));
    await waitFor(()=>expect(input.api.request).toHaveBeenCalledOnce());
    expect(screen.getByRole('status')).toHaveTextContent('برای این تصویر نتیجهٔ ردیابی وجود ندارد');
  });
});
