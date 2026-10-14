import { describe,it,expect,vi } from 'vitest';
import { TraceLog } from './trace';
import { DiagnosticSync } from './diagnosticSync';
import { sendDiagnosticBatch } from './diagnosticSync';

describe('bounded automatic diagnostic upload without recursive API tracing',()=>{
  it('transmits strict typed evidence and marker rejection counts without free fields',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({accepted:1})));vi.stubGlobal('fetch',fetcher);
    const log=new TraceLog();log.add('tracking','evidence',{evidenceSnapshot:{role:'camera',stage:'rejected',colorSpace:'srgb',rgbEncoding:'encoded',presentedFrames:4,rawMediaTime:0,rejectionReasons:['markerMissing'],bands:[{bandIndex:0,targetRgb:[0,.2,.4]}],token:'private'},markerSentinels:2,markerRejections:{ambiguousCells:3}});
    await sendDiagnosticBatch('s','t',{events:log.entries()});const event=JSON.parse(fetcher.mock.calls[0][1].body).events[0];
    expect(event.event).toBe('evidence');expect(event.details).toMatchObject({evidenceSnapshot:{role:'camera',stage:'rejected',rawMediaTime:0,bands:[{targetRgb:[0,.2,.4]}]},markerSentinels:2,markerRejections:{ambiguousCells:3}});expect(fetcher.mock.calls[0][1].body).not.toContain('private');vi.unstubAllGlobals();
  });
  it('uploads redacted events and resumes after successful batch',async()=>{
    const log=new TraceLog();log.add('camera','opened',{width:640,token:'private'});
    const send=vi.fn().mockResolvedValue({accepted:1,diagnosticId:'test-1'});
    const sync=new DiagnosticSync(log,send);await sync.flush();await sync.flush();
    expect(send).toHaveBeenCalledOnce();expect(send.mock.calls[0][0].events[0].details).toEqual({width:640});
    log.add('tracking','geometry',{candidateCount:2});await sync.flush();expect(send).toHaveBeenCalledTimes(2);
    expect(sync.status().savedSequence).toBe(2);expect(sync.status().diagnosticId).toBe('test-1');
  });
  it('retains failed batch, bounds upload and never overlaps slow sends',async()=>{
    const log=new TraceLog();for(let i=0;i<250;i++)log.add('tracking','geometry',{candidateCount:2});
    let finish!:(value:unknown)=>void;const send=vi.fn().mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const sync=new DiagnosticSync(log,send);const first=sync.flush();await sync.flush();expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].events.length).toBeLessThanOrEqual(80);finish({accepted:80});await first;
    expect(sync.status().savedSequence).toBe(80);
    send.mockRejectedValueOnce(new Error('offline'));await sync.flush();expect(sync.status().state).toBe('retry');
    send.mockResolvedValueOnce({accepted:80});await sync.flush();expect(sync.status().savedSequence).toBe(160);
  });
  it('does not save image data and stops timer without hidden retries',async()=>{
    vi.useFakeTimers();const log=new TraceLog();log.add('camera','opened',{pixels:[[1,2,3]]});
    const send=vi.fn().mockResolvedValue({accepted:1});const sync=new DiagnosticSync(log,send);sync.start();
    await vi.advanceTimersByTimeAsync(3000);expect(send).toHaveBeenCalledOnce();sync.stop();
    log.add('camera','closed');await vi.advanceTimersByTimeAsync(10000);expect(send).toHaveBeenCalledOnce();vi.useRealTimers();
  });
  it('uploads new trace generation even when clear rebuilds more events before the next tick',async()=>{
    const log=new TraceLog();const send=vi.fn().mockResolvedValue({accepted:2});const sync=new DiagnosticSync(log,send);
    log.add('camera','opened');log.add('camera','closed');await sync.flush();log.clear();
    for(let i=0;i<4;i++)log.add('tracking','geometry',{candidateCount:i});await sync.flush();
    expect(send.mock.calls[1][0].events).toHaveLength(4);expect(send.mock.calls[1][0].events[0].sequence).toBeGreaterThan(2);
  });
  it('uploads only schema-approved scalars not free text nested evidence or client timestamps',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({accepted:1})));vi.stubGlobal('fetch',fetcher);
    const log=new TraceLog();log.add('tracking','geometry',{phase:'cards',message:'private text',candidateCount:2,reason:'missingCardCandidates',fresh:null,evidence:{candidateCount:3}});
    await sendDiagnosticBatch('s','t',{events:log.entries()});
    const event=JSON.parse(fetcher.mock.calls[0][1].body).events[0];
    expect(event).not.toHaveProperty('at');expect(event.details).toEqual({phase:'neutral',candidateCount:2,reason:'missingCardCandidates'});
    vi.unstubAllGlobals();
  });
});
