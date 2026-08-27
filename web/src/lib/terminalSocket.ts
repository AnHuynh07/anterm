import type { ClientMessage, ServerMessage } from '../types';
import { wsUrl } from './api';

export interface TerminalSocketHandlers {
  onData: (chunk: Uint8Array) => void;
  onStatus: (state: 'connecting' | 'ready' | 'closed', detail?: string) => void;
  onHostKey: (msg: Extract<ServerMessage, { t: 'hostkey-prompt' }>) => void;
  onError: (message: string) => void;
  onToken?: (token: string) => void;
}

/**
 * Wrapper around /ws/terminal. On the first connect it sends `open`; the server
 * replies with a resume token. If the socket drops unexpectedly it reconnects
 * and sends `attach <token>` — the server kept the SSH session alive during a
 * grace window and replays whatever output was missed.
 */
export class TerminalSocket {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private sessionEnded = false;
  private reconnects = 0;
  private token: string | null = null;
  private lastSize: { cols: number; rows: number };
  private readonly open: Extract<ClientMessage, { t: 'open' }>;

  constructor(
    open: Omit<Extract<ClientMessage, { t: 'open' }>, 't'>,
    private readonly handlers: TerminalSocketHandlers,
    initialToken?: string,
  ) {
    this.open = { t: 'open', ...open };
    this.lastSize = { cols: open.cols, rows: open.rows };
    this.token = initialToken ?? null;
  }

  connect(): void {
    this.closedByUser = false;
    const ws = new WebSocket(wsUrl('/ws/terminal'));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.reconnects = 0;
      if (this.token) {
        this.send({ t: 'attach', token: this.token, ...this.lastSize });
      } else {
        this.send(this.open);
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.handleControl(JSON.parse(ev.data) as ServerMessage);
      } else {
        this.handlers.onData(new Uint8Array(ev.data as ArrayBuffer));
      }
    };
    ws.onclose = () => {
      if (this.closedByUser || this.sessionEnded) return;
      if (this.reconnects >= 6) {
        this.handlers.onStatus('closed', 'connection lost');
        return;
      }
      this.reconnects += 1;
      this.handlers.onStatus('connecting', `reconnecting (${this.reconnects})…`);
      setTimeout(() => this.connect(), Math.min(500 * 2 ** this.reconnects, 8000));
    };
    ws.onerror = () => {
      /* surfaced via onclose */
    };
  }

  private handleControl(msg: ServerMessage): void {
    switch (msg.t) {
      case 'attached':
        this.token = msg.token;
        this.handlers.onToken?.(msg.token);
        if (msg.resumed) this.handlers.onStatus('ready', 'reconnected');
        break;
      case 'status':
        if (msg.state === 'closed') this.sessionEnded = true;
        this.handlers.onStatus(msg.state, msg.detail);
        break;
      case 'hostkey-prompt':
        this.handlers.onHostKey(msg);
        break;
      case 'error':
        this.handlers.onError(msg.message);
        break;
      case 'pong':
        break;
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendData(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(new TextEncoder().encode(data));
  }

  resize(cols: number, rows: number): void {
    this.lastSize = { cols, rows };
    this.send({ t: 'resize', cols, rows });
  }

  answerHostKey(accept: boolean): void {
    this.send({ t: 'hostkey', accept });
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }
}
