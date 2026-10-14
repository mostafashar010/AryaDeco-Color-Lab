import { describe, expect, it, vi, afterEach } from 'vitest';
import { Connection } from './connection';
import { diagnosticTrace } from './trace';

class Socket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; }
}
afterEach(() => vi.useRealTimers());
describe('authenticated paused socket lifecycle', () => {
  it('does not export untrusted server reason status or credential as diagnostics',()=>{
    diagnosticTrace.clear();const socket=new Socket();
    const c=new Connection({sessionId:'s',token:'secretcredential123',role:'camera'},()=>{},()=>{},()=>socket as never);
    c.connect('https://lab.test');socket.onopen!();
    socket.onmessage!({data:JSON.stringify({protocolVersion:1,sessionId:'s',role:'server',messageId:'m',sequenceId:1,event:'session.pause',payload:{reason:'secretcredential123',status:'device_serial_abc123'}})});
    expect(diagnosticTrace.toJSON()).not.toMatch(/secretcredential123|device_serial_abc123/);c.stop();
  });
  it('authenticates first with sequence 1 and heartbeats with increasing sequence', () => {
    vi.useFakeTimers();
    const s = new Socket();
    const factory = vi.fn(() => s);
    const connection = new Connection({ sessionId: 's', token: 'private', role: 'camera' }, () => {}, () => {}, factory as never);
    connection.connect('https://lab.test');
    s.onopen!();
    expect(factory.mock.calls[0]).toEqual(['wss://lab.test/ws/s']);
    expect(JSON.parse(s.sent[0])).toMatchObject({ event: 'device.join', sequenceId: 1, role: 'camera', payload: { token: 'private' } });
    vi.advanceTimersByTime(10000);
    expect(JSON.parse(s.sent[1])).toMatchObject({ event: 'heartbeat', sequenceId: 2 });
    connection.stop();
  });
  it('drops duplicate and foreign envelopes and never queues stale commands on disconnect', () => {
    vi.useFakeTimers();
    const first = new Socket(); const second = new Socket();
    const notice = vi.fn(); const status = vi.fn();
    const c = new Connection({ sessionId: 's', token: 't', role: 'camera' }, notice, status, vi.fn().mockReturnValueOnce(first).mockReturnValue(second));
    c.connect('https://lab.test'); first.onopen!();
    const event = { protocolVersion: 1, sessionId: 's', role: 'server', messageId: 'm', sequenceId: 1, event: 'session.state', payload: {} };
    first.onmessage!({ data: JSON.stringify(event) }); first.onmessage!({ data: JSON.stringify(event) });
    first.onmessage!({ data: JSON.stringify({ ...event, sessionId: 'other', sequenceId: 2 }) });
    expect(notice).toHaveBeenCalledTimes(1);
    first.readyState = 3; first.onclose!();
    expect(c.send('display.patch.set', {})).toBe(false);
    vi.advanceTimersByTime(1500); second.onopen!();
    expect(second.sent).toHaveLength(1);
    expect(status).toHaveBeenCalledWith('paused');
    expect(second.sent.join('')).not.toContain('session.resume');
    c.stop();
  });
});
