import type { ClientMessage, ServerMessage } from '../types';
import { wsUrl } from './api';

export interface TerminalSocketHandlers {
  onData: (chunk: Uint8Array) => void;
  onStatus: (state: 'connecting' | 'ready' | 'closed', detail?: string) => void;
  onHostKey: (msg: Extract<ServerMessage, { t: 'hostkey-prompt' }>) => void;
  onError: (message: string) => void;
}

/**
 * Thin wrapper around the /ws/terminal socket. Handles binary<->control framing
 * and a bounded auto-reconnect for transient network drops (the SSH session
 * itself does not survive a reconnect — the caller decides whether to re-open).
 */
export class TerminalSocket {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private sessionEnded = false;
  private reconnects = 0;
  private readonly open: Extract<ClientMessage, { t: 'open' }>;

  constructor(
    open: Omit<Extract<ClientMessage, { t: 'open' }>, 't'>,
    private readonly handlers: TerminalSocketHandlers,
  ) {
    this.open = { t: 'open', ...open };
  }

  connect(): void {
    this.closedByUser = false;
    const ws = new WebSocket(wsUrl('/ws/terminal'));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.reconnects = 0;
      this.send(this.open);
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
      if (this.reconnects >= 4) {
        this.handlers.onStatus('closed', 'connection lost');
        return;
      }
      this.reconnects += 1;
      this.handlers.onStatus('connecting', `reconnecting (${this.reconnects})…`);
      setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.reconnects, 8000));
    };
    ws.onerror = () => {
      /* surfaced via onclose */
    };
  }

  private handleControl(msg: ServerMessage): void {
    switch (msg.t) {
      case 'status':
        // A server-sent "closed" is a real session end (SSH exited, host key
        // rejected, timeout) — don't auto-reconnect into a brand-new shell.
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
