import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { TerminalSocket } from '../lib/terminalSocket';
import type { AdhocTarget, HostKeyPromptMsg } from '../types';
import { HostKeyPrompt } from './HostKeyPrompt';

const THEME = {
  background: '#0b0e14',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#3a3f58',
};

interface Props {
  connectionId?: string;
  adhoc?: AdhocTarget;
  onExit?: (reason: string) => void;
}

export function TerminalView({ connectionId, adhoc, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'closed'>('connecting');
  const [statusDetail, setStatusDetail] = useState<string>();
  const [hostKey, setHostKey] = useState<HostKeyPromptMsg | null>(null);
  const socketRef = useRef<TerminalSocket | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: THEME,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new SearchAddon());
    term.loadAddon(new ClipboardAddon());
    term.open(el);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* webgl unavailable — canvas renderer is fine */
    }
    fit.fit();

    const socket = new TerminalSocket(
      { connectionId, adhoc, cols: term.cols, rows: term.rows },
      {
        onData: (chunk) => term.write(chunk),
        onStatus: (state, detail) => {
          setStatus(state);
          setStatusDetail(detail);
          if (state === 'ready') term.focus();
          if (state === 'closed') {
            term.write(`\r\n\x1b[90m— session closed${detail ? `: ${detail}` : ''} —\x1b[0m\r\n`);
            onExit?.(detail ?? 'closed');
          }
        },
        onHostKey: (msg) => setHostKey(msg),
        onError: (message) => term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`),
      },
    );
    socketRef.current = socket;
    socket.connect();

    const disposeData = term.onData((d) => socket.sendData(d));
    const disposeResize = term.onResize(({ cols, rows }) => socket.resize(cols, rows));

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore transient layout errors */
      }
    });
    ro.observe(el);

    const ping = setInterval(() => socket.send({ t: 'ping' }), 25_000);

    return () => {
      clearInterval(ping);
      ro.disconnect();
      disposeData.dispose();
      disposeResize.dispose();
      socket.close();
      term.dispose();
    };
  }, [connectionId, adhoc, onExit]);

  return (
    <div className="terminal-wrap">
      <div className={`term-status ${status}`}>
        {status === 'connecting' && (statusDetail ?? 'Connecting…')}
        {status === 'ready' && 'Connected'}
        {status === 'closed' && (statusDetail ? `Closed: ${statusDetail}` : 'Closed')}
      </div>
      <div className="terminal-host" ref={hostRef} />
      {hostKey && (
        <HostKeyPrompt
          msg={hostKey}
          onDecision={(accept) => {
            socketRef.current?.answerHostKey(accept);
            setHostKey(null);
          }}
        />
      )}
    </div>
  );
}
