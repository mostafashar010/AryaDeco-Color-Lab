import { describe, expect, it, vi } from 'vitest';
import { Api, consumeJoin, joinUrl } from './session';
import { diagnosticTrace } from './trace';

describe('session creation and fragment-only joining', () => {
  it('traces API endpoint class status and rejection code without ids or captures',async()=>{
    diagnosticTrace.clear();
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({detail:'fabric_target_drift'}),{status:422}));
    await expect(new Api('private-session',fetcher,'private-token').post('camera-matches/private-run/observe',{pixels:[[1,2,3]]})).rejects.toThrow();
    const exported=diagnosticTrace.toJSON();
    expect(exported).toContain('fabric_target_drift');expect(exported).toContain('422');
    expect(exported).not.toMatch(/private-session|private-run|private-token|pixels/);
  });
  it('does not log an unrecognized server detail as a supposedly safe code',async()=>{
    diagnosticTrace.clear();
    await expect(new Api('s',vi.fn().mockResolvedValue(new Response(JSON.stringify({detail:'private_token_value'}),{status:422}))).get()).rejects.toThrow();
    expect(diagnosticTrace.toJSON()).not.toContain('private_token_value');
  });
  it('preserves only controlled preview retry information for a transient rate response',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({detail:{code:'preview_rate_limit',retryAfterMs:300}}),{status:409}));
    try{await new Api('s',fetcher).post('live-preview',{});throw new Error('expected rejection');}
    catch(error){expect(error).toMatchObject({code:'preview_rate_limit',retryAfterMs:300,status:409});}
  });
  it('preserves only feedback-specific conflicts on the preview endpoint', async () => {
    for (const code of ['preview_feedback_stale_command', 'preview_feedback_context_changed', 'preview_feedback_expired']) {
      const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: code }), { status: 409 }));
      await expect(new Api('s', fetcher).post('live-preview', {})).rejects.toMatchObject({ status: 409, code });
      await expect(new Api('s', fetcher).post('camera-matches/run/observe', {})).rejects.not.toMatchObject({ code });
    }
    await expect(new Api('s', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'preview_feedback_unknown_private_detail' }), { status: 409 }))).post('live-preview', {})).rejects.not.toMatchObject({ code: 'preview_feedback_unknown_private_detail' });
  });
  it('creates the explicit selected mode with unknown conditions unchanged', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: 's1', cameraToken: 'c', displayToken: 'd' })));
    const api = new Api('', fetcher);
    await api.create('threeStage', { illumination: null, brightness: null });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ mode: 'threeStage', conditions: { illumination: null, brightness: null } });
  });
  it('consumes credentials once and scrubs location before returning', () => {
    const replace = vi.fn();
    const join = consumeJoin(new URL('https://lab.test/display#session=s1&token=secret'), replace);
    expect(join).toEqual({ sessionId: 's1', token: 'secret', role: 'display' });
    expect(replace).toHaveBeenCalledWith('/display');
    expect(joinUrl('https://lab.test', 's1', 'secret')).toBe('https://lab.test/display#session=s1&token=secret');
  });
  it('never puts bearer tokens in URL and redacts server errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('secret\ninternal traceback', { status: 401 }));
    const api = new Api('s1', fetcher, 'secret');
    await expect(api.get()).rejects.toThrow('401');
    expect(fetcher.mock.calls[0][0]).toBe('/api/sessions/s1');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
  });
  it('rejects oversized JSON before sending unsatisfiable capture batches', async () => {
    const fetcher = vi.fn(); const api = new Api('s', fetcher, 't');
    await expect(api.post('camera-profile', { value: 'a'.repeat(16 * 1024 * 1024) })).rejects.toThrow('حجم');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('invokes native fetch with global receiver rather than binding to Api instance', async () => {
    const native = vi.fn(function (this: unknown) { if (this !== globalThis) throw new TypeError('Illegal invocation'); return Promise.resolve(new Response('{}')); });
    await expect(new Api('s', native as never, 't').get()).resolves.toEqual({});
  });
  it('explains recognized live failure with the next physical action rather than generic HTTP', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'fabric_target_drift' }), { status: 422 }));
    await expect(new Api('s', fetcher).post('matches/r/observe', {})).rejects.toThrow('پارچه');
    const hostile = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'secret internal traceback cameraToken=secret' }), { status: 500 }));
    await expect(new Api('s', hostile).get()).rejects.not.toThrow('cameraToken');
  });
});
