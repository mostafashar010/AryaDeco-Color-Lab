import { describe,it,expect } from 'vitest';
import { TraceLog,diagnosticErrorCode } from './trace';

describe('bounded private local diagnostic trace',()=>{
  it('uses controlled capture error codes without logging arbitrary Error text or fake code prefixes',()=>{
    expect(diagnosticErrorCode(new Error('نشانگر فیزیکی مربوط به فرمان جاری نیست.'))).toBe('capture_marker_mismatch');
    expect(diagnosticErrorCode(Object.assign(new Error('Bearer private'),{code:'capture_private_credential'}))).toBe('capture_unclassified');
    expect(diagnosticErrorCode(Object.assign(new Error('private'),{code:'response_neutral_witness_drift'}))).toBe('response_neutral_witness_drift');
    expect(diagnosticErrorCode(new DOMException('private','AbortError'))).toBe('capture_aborted');
    expect(diagnosticErrorCode(new Error('مرورگر زمان ویدئو را ثابت گزارش می‌کند؛ پیش‌نمایش زنده کار می‌کند اما برداشت دقیق در این مسیر تأیید نمی‌شود. از نمایش زندهٔ کالیته استفاده کنید.'))).toBe('capture_frozen_video_clock');
  });
  it('requires explicit RGB domain residual metric and unique indices in sanitized evidence',()=>{
    const trace=new TraceLog();trace.add('tracking','evidence',{evidenceSnapshot:{role:'camera',stage:'sampled',bands:[{bandIndex:0,observedRgb:[0,0,0],residualBefore:.1},{bandIndex:0,targetRgb:[1,1,1]}]}});
    expect((trace.entries()[0].details.evidenceSnapshot as {bands:object[]}).bands).toEqual([{bandIndex:0}]);
  });
  it('retains strictly bounded color evidence without arbitrary fields or credentials',()=>{
    const trace=new TraceLog();
    trace.add('tracking','evidence',{markerSentinels:3,markerRejections:{ambiguousCells:2,token:12},evidenceSnapshot:{role:'camera',stage:'rejected',commandSequence:7,presentedFrames:12,rawMediaTime:0,nativeWidth:2160,nativeHeight:2160,analysisWidth:640,analysisHeight:640,colorSpace:'srgb',rgbEncoding:'encoded',physicalAccuracyVerified:false,rejectionReasons:['markerMissing','Bearer secret'],markerCells:Array(40).fill([0,1,.5]),screenRoi:[[0,0],[1,0],[1,1],[0,1]],bands:Array.from({length:40},(_,bandIndex)=>({bandIndex:bandIndex%32,targetRgb:[0,.2,1],observedRgb:[.1,.3,.9],token:'secret',quality:{status:'rejected',validPixels:16,shadowClippedRate:1},reasons:['cameraShadowClipped'],rawPixels:[[1,2,3]]})),token:'secret',image:'data:image/png;base64,secret'}});
    const details=trace.entries()[0].details,e=details.evidenceSnapshot as Record<string,unknown>;
    expect(e).toMatchObject({role:'camera',rawMediaTime:0,colorSpace:'srgb',rgbEncoding:'encoded',rejectionReasons:['markerMissing']});
    expect(e.bands).toHaveLength(32);expect(e.markerCells).toHaveLength(28);
    expect((e.bands as object[])[0]).toMatchObject({targetRgb:[0,.2,1],observedRgb:[.1,.3,.9],quality:{shadowClippedRate:1}});
    expect(details.markerRejections).toEqual({ambiguousCells:2});expect(details.markerSentinels).toBe(3);
    expect(trace.toJSON()).not.toMatch(/secret|rawPixels|data:image|Bearer/);
  });
  it('drops malformed RGB, nonfinite geometry and unsupported evidence stages',()=>{
    const trace=new TraceLog();
    trace.add('tracking','evidence',{evidenceSnapshot:{role:'camera',stage:'sampled',colorSpace:'srgb',rgbEncoding:'encoded',nativeWidth:Infinity,screenRoi:[[0,0],[2,0],[1,1]],bands:[{bandIndex:0,targetRgb:[NaN,0,0],driveRgb:[0,0,2],observedRgb:[0,0,0],quality:{validPixels:1e12,clippedRate:-1}}]}});
    const evidence=trace.entries()[0].details.evidenceSnapshot as Record<string,unknown>;
    expect(evidence).not.toHaveProperty('nativeWidth');expect(evidence).not.toHaveProperty('screenRoi');
    expect((evidence.bands as object[])[0]).toEqual({bandIndex:0,observedRgb:[0,0,0]});
    trace.add('tracking','evidence',{evidenceSnapshot:{role:'camera',stage:'token=private'}});
    expect(trace.entries()[1].details).not.toHaveProperty('evidenceSnapshot');
  });
  it('records ordered elapsed events and finite summary evidence',()=>{
    let now=100;
    const trace=new TraceLog(()=>now);
    trace.add('camera','opened',{width:1280,height:720}); now=250;
    trace.add('tracking','needsFraming',{cardCount:2,message:'کارت روشن دیده نشد'});
    const report=JSON.parse(trace.toJSON());
    expect(report.events[1].elapsedMs).toBe(150);
    expect(report.events[0].sequence).toBe(1);
    expect(report.events[1].details.cardCount).toBe(2);
    expect(report.containsImages).toBe(false);
  });
  it('redacts tokens arbitrary urls identities raw pixels and nested payload secrets',()=>{
    const trace=new TraceLog();
    trace.add('api','request',{cameraToken:'secret1',displayToken:'secret2',token:'secret3',authorization:'Bearer secret4',url:'https://host/display#token=secret5',pixels:[[1,2,3]],payload:{token:'secret6'},deviceLabel:'user private phone',message:'error https://host/?token=secret7 Bearer secret8',settings:{deviceId:'secret9',width:640}});
    const exported=trace.toJSON();
    expect(exported).not.toMatch(/secret[1-9]|user private phone|\[1,2,3\]/);
    expect(exported).toContain('640');
  });
  it('bounds event count and payload size, reports dropped events',()=>{
    const trace=new TraceLog();
    for(let i=0;i<550;i++) trace.add('tracking','update',{message:'x'.repeat(10000)});
    const report=JSON.parse(trace.toJSON());
    expect(report.events.length).toBeLessThanOrEqual(300);
    expect(report.droppedEvents).toBeGreaterThan(0);
    expect(report.events.at(-1).details.message.length).toBeLessThanOrEqual(400);
  });
  it('notifies live UI, unsubscribes, and clears only diagnostic data',()=>{
    const trace=new TraceLog(); let called=0;
    const unsubscribe=trace.subscribe(()=>called++);
    trace.add('camera','opened'); unsubscribe(); trace.add('camera','closed');
    expect(called).toBe(1);
    trace.clear(); expect(trace.entries()).toHaveLength(0);
  });
  it('rejects encoded images credentials embedded in JSON and bounds each whole event',()=>{
    const trace=new TraceLog();
    trace.add('tracking','update',{message:'{"token":"private-token-value"} data:image/png;base64,c2VjcmV0aW1hZ2U=',notes:'private-session-id',evidence:Object.fromEntries(Array.from({length:48},(_,i)=>[`a${i}`,Object.fromEntries(Array.from({length:48},(_,j)=>[`b${j}`,'x'.repeat(400)]))]))});
    const text=trace.toJSON();expect(text).not.toMatch(/private-token-value|private-session-id|c2VjcmV0aW1hZ2U/);
    expect(text.length).toBeLessThan(16000);
  });
});
