import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { decodeMarker, markerCells, sampleMarker } from './marker';
import { Display } from './Display';
import type { Patch } from './session';
import { TraceLog } from './trace';

describe('physical command marker and flat display', () => {
  it('records a fresh two-frame evidence after late consent without duplicating protocol ACK',()=>{
    const queue:FrameRequestCallback[]=[];vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{queue.push(callback);return queue.length;});vi.stubGlobal('cancelAnimationFrame',vi.fn());
    const trace=new TraceLog(),rendered=vi.fn(),patch:Patch={patchId:'p',profileVersion:0,commandSequence:3,layout:'single',displayDriveRgb:[0,0,0],sampleIds:[]};
    const view=render(<Display patch={patch} paused={false} onRendered={rendered} trace={trace} diagnosticsEnabled={false}/>);
    act(()=>queue.shift()!(1));act(()=>queue.shift()!(2));expect(trace.entries()).toHaveLength(0);
    view.rerender(<Display patch={patch} paused={false} onRendered={rendered} trace={trace} diagnosticsEnabled/>);
    expect(trace.entries()).toHaveLength(0);act(()=>queue.shift()!(3));expect(trace.entries()).toHaveLength(0);act(()=>queue.shift()!(4));
    expect(trace.entries()).toHaveLength(1);expect(rendered).toHaveBeenCalledOnce();vi.unstubAllGlobals();
  });
  it('keeps physical render ACK but emits no evidence when diagnostics consent is disabled',()=>{
    const queue:FrameRequestCallback[]=[];vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{queue.push(callback);return queue.length;});vi.stubGlobal('cancelAnimationFrame',vi.fn());
    const trace=new TraceLog(),rendered=vi.fn();render(<Display patch={{patchId:'p',profileVersion:0,commandSequence:3,layout:'single',displayDriveRgb:[0,0,0],sampleIds:[]}} paused={false} onRendered={rendered} trace={trace} diagnosticsEnabled={false}/>);
    act(()=>queue.shift()!(1));act(()=>queue.shift()!(2));expect(rendered).toHaveBeenCalledOnce();expect(trace.entries()).toHaveLength(0);vi.unstubAllGlobals();
  });
  it('records actual rounded CSS sRGB paint only after real two-frame acknowledgement',()=>{
    const queue:FrameRequestCallback[]=[];vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{queue.push(callback);return queue.length;});vi.stubGlobal('cancelAnimationFrame',vi.fn());
    const trace=new TraceLog(),rendered=vi.fn();
    render(<Display patch={{patchId:'private-id',profileVersion:2,commandSequence:7,layout:'liveBands',displayDriveRgb:[.2,.3,.4],sampleIds:[],bands:[{id:'private-band',drive:[0,.25,1],top:0,bottom:1}]}} paused={false} onRendered={rendered} trace={trace}/>);
    expect(trace.entries()).toHaveLength(0);act(()=>queue.shift()!(1));expect(trace.entries()).toHaveLength(0);act(()=>queue.shift()!(2));
    expect(trace.entries()[0].details.evidenceSnapshot).toMatchObject({role:'display',stage:'rendered',commandSequence:7,status:'renderRequestOnly',physicalAccuracyVerified:false,colorSpace:'srgb',rgbEncoding:'encoded',renderedProof:'twoAnimationFrames',bands:[{bandIndex:0,driveRgb:[0,.25,1],renderedPaintRgb:[0,64/255,1]}]});
    expect(trace.toJSON()).not.toMatch(/private-id|private-band/);expect(rendered.mock.calls[0][0]).not.toHaveProperty('evidenceSnapshot');vi.unstubAllGlobals();
  });
  it('distinguishes measured feedback from feedforward and shows before-error without claiming after accuracy', () => {
    const patch: Patch = { patchId: 'feedback', commandSequence: 17, displayDriveRgb: [0.5, 0.5, 0.5], profileVersion: 2, layout: 'liveBands', sampleIds: ['a', 'b'], bands: [{ id: 'a', drive: [0.4, 0.3, 0.2], top: 0, bottom: 0.4 }, { id: 'b', drive: [0.2, 0.4, 0.3], top: 0.5, bottom: 1 }], compensation: { status: 'measuredFeedbackExperimental', feedbackApplied: true, perBand: [{ id: 'a', status: 'measuredFeedbackExperimental', residualBefore: 0.0321, residualAfter: null, saturated: false, warnings: [] }, { id: 'b', status: 'measuredFeedbackExperimental', residualBefore: 0.0523, residualAfter: null, saturated: true, warnings: ['driveSaturated'] }] } };
    const view = render(<Display patch={patch} paused={false} onRendered={vi.fn()} />);
    expect(screen.getByText(/بازخورد اندازه‌گیری‌شدهٔ صفحه/)).toBeInTheDocument();
    expect(screen.getByLabelText('خطای پیش از اصلاح نوار a')).toHaveTextContent('0.0321');
    expect(screen.getByLabelText('خطای پیش از اصلاح نوار b')).toHaveTextContent('0.0523');
    expect(screen.getByLabelText('خطای پیش از اصلاح نوار b')).toHaveTextContent('محدودیت فرمان');
    expect(screen.getByLabelText('خطای پیش از اصلاح نوار a')).toHaveTextContent('RGB دوربین');
    expect(screen.getByLabelText('خطای پیش از اصلاح نوار a')).not.toHaveTextContent(/ΔE|%|پس از اصلاح/);
    view.rerender(<Display patch={{ ...patch, commandSequence: 18, compensation: { status: 'cameraReferencedExperimental' } }} paused={false} onRendered={vi.fn()} />);
    expect(screen.getByText(/جبران مدل پاسخ، بدون بازخورد تازهٔ صفحه/)).toBeInTheDocument();
    expect(screen.queryByLabelText('خطای پیش از اصلاح نوار a')).not.toBeInTheDocument();
    view.rerender(<Display patch={{ ...patch, commandSequence: 19, compensation: { status: 'partiallyCompensatedExperimental' } }} paused={false} onRendered={vi.fn()} />);
    expect(screen.getByText(/جبران مدل فقط برای بعضی نوارها/)).toBeInTheDocument();
  });
  it('guides physical placement on the waiting screen without asking for manual ROI', () => {
    render(<Display patch={null} paused={true} onRendered={vi.fn()} />);
    expect(screen.getByText(/این گوشی را کنار پارچه بگذارید/)).toBeInTheDocument();
    expect(screen.getByText(/کارها را فقط روی گوشی دوربین B/)).toBeInTheDocument();
  });
  it('encodes 24 MSB-first bits after alternating sentinel without truncation', () => {
    expect(markerCells(1)).toEqual([0, 1, 0, 1, ...Array(23).fill(0), 1]);
    expect(decodeMarker(markerCells(256).map(v => [v, v, v]))).toBe(256);
    expect(() => markerCells(16777216)).toThrow();
    expect(() => decodeMarker(Array(28).fill([0.5, 0.5, 0.5]))).toThrow();
  });
  it('samples interior geometry from marker rectangular ROI, rejecting tiny geometry', () => {
    const bits = markerCells(9); const data = new Uint8ClampedArray(280 * 10 * 4);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 280; x++) {
      const index = (y * 280 + x) * 4; data.set([bits[Math.floor(x / 10)] * 255, bits[Math.floor(x / 10)] * 255, bits[Math.floor(x / 10)] * 255, 255], index);
    }
    expect(decodeMarker(sampleMarker({ data, width: 280, height: 10 }, { x: 0, y: 0, width: 280, height: 10 }))).toBe(9);
    expect(() => sampleMarker({ data, width: 280, height: 10 }, { x: 0, y: 0, width: 28, height: 1 })).toThrow();
  });
  it('acknowledges only after two animation frames and keeps marker outside opaque patch', () => {
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { queue.push(f); return queue.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const rendered = vi.fn();
    render(<Display patch={{ patchId: 'p', commandSequence: 9, displayDriveRgb: [1, 0.25, 0], profileVersion: 2, layout: 'single', sampleIds: [] }} paused={false} onRendered={rendered} />);
    expect(rendered).not.toHaveBeenCalled(); act(() => queue.shift()!(1));
    expect(rendered).not.toHaveBeenCalled(); act(() => queue.shift()!(2));
    expect(rendered).toHaveBeenCalledWith(expect.objectContaining({ patchId: 'p', commandSequence: 9, profileVersion: 2 }));
    expect(screen.getByTestId('flat-patch')).toHaveStyle({ backgroundColor: 'rgb(255, 64, 0)', opacity: '1' });
    expect(screen.getByTestId('flat-patch')).not.toContainElement(screen.getByTestId('marker'));
    vi.unstubAllGlobals();
  });
  it('renders distinct simultaneous group cards but never labels group match verified', () => {
    render(<Display patch={{ patchId: 'group', commandSequence: 10, displayDriveRgb: [0, 0, 0], profileVersion: 2, layout: 'group', sampleIds: ['a', 'b'], patches: [{ sampleId: 'a', drive: [1, 0, 0] }, { sampleId: 'b', drive: [0, 1, 0] }] }} paused={false} onRendered={vi.fn()} />);
    expect(screen.getByTestId('group-card-a')).toHaveStyle({ backgroundColor: 'rgb(255, 0, 0)' });
    expect(screen.getByTestId('group-card-b')).toHaveStyle({ backgroundColor: 'rgb(0, 255, 0)' });
    expect(screen.getByText(/اعتبار گروهی تأیید نشده/)).toBeInTheDocument();
  });
  it('never repeats render acknowledgement due to unrelated React rerenders or server rendered flag', () => {
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { queue.push(f); return queue.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const rendered = vi.fn(); const patch = { patchId: 'p', commandSequence: 9, displayDriveRgb: [0.2, 0.2, 0.2] as [number, number, number], profileVersion: 2, layout: 'single' as const, sampleIds: [] };
    const view = render(<Display patch={patch} paused={false} onRendered={rendered} />);
    act(() => queue.shift()!(1)); act(() => queue.shift()!(2));
    view.rerender(<Display patch={{ ...patch, rendered: true }} paused={false} onRendered={payload => rendered(payload)} />);
    expect(queue).toHaveLength(0); expect(rendered).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
  it('renders live bands at their real vertical positions across the entire sampling domain', () => {
    render(<Display patch={{ patchId: 'live', commandSequence: 11, displayDriveRgb: [0.5, 0.5, 0.5], profileVersion: 2, layout: 'liveBands', sampleIds: ['a', 'b'], bands: [{ id: 'a', drive: [1, 0, 0], top: 0.1, bottom: 0.3 }, { id: 'b', drive: [0, 1, 0], top: 0.6, bottom: 0.9 }], mapping: 'screenAligned' }} paused={false} onRendered={vi.fn()} />);
    expect(screen.getByTestId('live-band-a')).toHaveStyle({ top: '10%', height: '20%', width: '100%', opacity: '1', backgroundColor: 'rgb(255, 0, 0)' });
    expect(screen.getByTestId('live-band-b')).toHaveStyle({ top: '60%', height: '30%', backgroundColor: 'rgb(0, 255, 0)' });
    expect(screen.getByTestId('live-band-domain')).not.toContainElement(screen.getByTestId('marker'));
    expect(screen.getByText(/RGB دوربین بدون جبران پاسخ نمایشگر/)).toBeInTheDocument();
  });
  it('rejects overlapping live bands instead of rendering a misleading alignment', () => {
    render(<Display patch={{ patchId: 'bad', commandSequence: 12, displayDriveRgb: [0.5, 0.5, 0.5], profileVersion: 2, layout: 'liveBands', sampleIds: [], bands: [{ id: 'a', drive: [1, 0, 0], top: 0, bottom: 0.7 }, { id: 'b', drive: [0, 1, 0], top: 0.6, bottom: 1 }] }} paused={false} onRendered={vi.fn()} />);
    expect(screen.queryByTestId('live-band-domain')).not.toBeInTheDocument();
  });
  it('acknowledges each fresh live-band color command only after two animation frames', () => {
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { queue.push(f); return queue.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const rendered = vi.fn(), patch = { patchId: 'liveAck', commandSequence: 15, displayDriveRgb: [0.5, 0.5, 0.5] as [number, number, number], profileVersion: 2, layout: 'liveBands' as const, sampleIds: [], bands: [{ id: 'a', drive: [1, 0, 0] as [number, number, number], top: 0, bottom: 1 }] };
    const view = render(<Display patch={patch} paused={false} onRendered={rendered} />);
    act(() => queue.shift()!(1)); expect(rendered).not.toHaveBeenCalled(); act(() => queue.shift()!(2)); expect(rendered).toHaveBeenCalledTimes(1);
    view.rerender(<Display patch={{ ...patch, commandSequence: 16, bands: [{ ...patch.bands[0], drive: [0, 0, 1] }] }} paused={false} onRendered={rendered} />);
    act(() => queue.shift()!(3)); expect(rendered).toHaveBeenCalledTimes(1); act(() => queue.shift()!(4));
    expect(rendered).toHaveBeenLastCalledWith(expect.objectContaining({ commandSequence: 16 }));
    expect(screen.getByTestId('live-band-a')).toHaveStyle({ backgroundColor: 'rgb(0, 0, 255)' }); vi.unstubAllGlobals();
  });
  it('holds the last live image briefly on pause then blanks it with a stale warning', () => {
    vi.useFakeTimers();
    const patch = { patchId: 'ttl', commandSequence: 13, displayDriveRgb: [0.5, 0.5, 0.5] as [number, number, number], profileVersion: 2, layout: 'liveBands' as const, sampleIds: [], bands: [{ id: 'a', drive: [1, 0, 0] as [number, number, number], top: 0, bottom: 1 }] };
    const view = render(<Display patch={patch} paused={false} onRendered={vi.fn()} />);
    act(() => vi.advanceTimersByTime(1500));
    view.rerender(<Display patch={null} paused={true} onRendered={vi.fn()} />);
    expect(screen.getByTestId('live-band-a')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1001));
    expect(screen.queryByTestId('live-band-a')).not.toBeInTheDocument();
    expect(screen.getByText(/پیش‌نمایش تازه نرسید/)).toBeInTheDocument();
    vi.useRealTimers();
  });
});
