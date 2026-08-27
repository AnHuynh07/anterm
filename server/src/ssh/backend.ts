export interface CloseInfo {
  code: number | null;
  signal: string | null;
  reason: string;
}

interface BackendEvents {
  ready: () => void;
  data: (chunk: Buffer) => void;
  close: (info: CloseInfo) => void;
  error: (err: Error) => void;
}

/** Common surface for an interactive terminal backend (SSH channel or local PTY). */
export interface TerminalBackend {
  connect(): void;
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  close(reason?: string): void;
  on<E extends keyof BackendEvents>(event: E, listener: BackendEvents[E]): unknown;
}
