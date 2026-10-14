import type { Credentials } from './session';
import { diagnosticTrace } from './trace';
export type Envelope = { event: string; protocolVersion: number; sessionId: string; messageId: string; sequenceId: number; role: string; payload: Record<string, unknown> };
export class Connection {
  private socket?: WebSocket;
  private sequence = 0;
  private serverSequence = 0;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private lastReceived = 0;
  constructor(private credentials: Credentials, private notice: (event: Envelope) => void, private status: (value: 'connecting' | 'connected' | 'paused') => void, private factory: (url: string) => WebSocket = url => new WebSocket(url)) {}
  connect(origin: string) {
    if (this.stopped) return;
    this.status('connecting'); diagnosticTrace.add('connection','connecting',{role:this.credentials.role});this.sequence = 0; this.serverSequence = 0;
    const url = new URL(`/ws/${encodeURIComponent(this.credentials.sessionId)}`, origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.factory(url.toString()); this.socket = socket;
    socket.onopen = () => {
      this.lastReceived = performance.now();
      this.send('device.join', { token: this.credentials.token });
      this.status('connected');
      diagnosticTrace.add('connection','opened',{role:this.credentials.role});
      this.timer = setInterval(() => {
        if (performance.now() - this.lastReceived > 30000) { socket.close(); this.status('paused'); }
        else this.send('heartbeat', { localTime: performance.now() });
      }, 10000);
    };
    socket.onmessage = e => {
      if (typeof e.data !== 'string' || e.data.length > 512000) return;
      try {
        const event: Envelope = JSON.parse(e.data);
        if (event.protocolVersion !== 1 || event.sessionId !== this.credentials.sessionId || event.role !== 'server' || !Number.isSafeInteger(event.sequenceId) || event.sequenceId <= this.serverSequence) return;
        this.serverSequence = event.sequenceId; this.lastReceived = performance.now();
        if(['display.patch.set','display.patch.rendered','session.pause','profile.invalidate','quality.alert','match.complete'].includes(event.event)) {
          const reasons=new Set('operator_pause page_hidden camera_moved device_disconnected socket_disconnected camera_track_ended camera_selection_changed camera_settings_changed camera_controls_changed canvas_color_space_changed camera_controls_changed roi_changed automatic_run_interrupted profile_invalidated'.split(' '));
          const statuses=new Set('complete rejected stopped pending accepted error'.split(' '));
          diagnosticTrace.add('connection',event.event,{sequence:event.sequenceId,commandSequence:typeof event.payload.commandSequence==='number'?event.payload.commandSequence:undefined,reason:typeof event.payload.reason==='string'&&reasons.has(event.payload.reason)?event.payload.reason:'unclassified',status:typeof event.payload.status==='string'&&statuses.has(event.payload.status)?event.payload.status:undefined});
        }
        this.notice(event);
      } catch { this.status('paused'); }
    };
    socket.onclose = () => {
      clearInterval(this.timer); this.status('paused');
      diagnosticTrace.add('connection','closed',{role:this.credentials.role,retry:!this.stopped});
      if (!this.stopped) this.retry = setTimeout(() => this.connect(origin), 1500);
    };
    socket.onerror = () => { this.status('paused'); socket.close(); };
  }
  send(event: string, payload: unknown) {
    if (this.stopped || this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify({ event, protocolVersion: 1, ...{ sessionId: this.credentials.sessionId, role: this.credentials.role }, messageId: crypto.randomUUID(), sequenceId: ++this.sequence, payload }));
    return true;
  }
  stop() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.retry); this.socket?.close(); }
}
