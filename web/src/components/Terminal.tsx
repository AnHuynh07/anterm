import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { TerminalSocket } from '../lib/terminalSocket';
import { colorizeChunk } from '../lib/highlight';
import { api } from '../lib/api';
import { useTerminalTabs } from '../hooks/useTerminalTabs';
import type { AdhocTarget, HostKeyPromptMsg, Snippet } from '../types';
import { HostKeyPrompt } from './HostKeyPrompt';
import { Badge } from './Badge';

const HL_KEY = 'anterm.highlight';

const THEME = {
  background: '#1b1e27',
  foreground: '#e6e9ef',
  cursor: '#f5e0dc',
  selectionBackground: '#39415a',
};

interface Props {
  tabKey: string;
  connectionId?: string;
  adhoc?: AdhocTarget;
  onExit?: (reason: string) => void;
}

export function TerminalView({ tabKey, connectionId, adhoc, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tabs = useTerminalTabs();
  const broadcastRef = useRef(tabs.broadcast);
  broadcastRef.current = tabs.broadcast;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [status, setStatus] = useState<'connecting' | 'ready' | 'closed'>('connecting');
  const [statusDetail, setStatusDetail] = useState<string>();
  const [hostKey, setHostKey] = useState<HostKeyPromptMsg | null>(null);
  const [highlight, setHighlight] = useState(() => {
    try {
      return localStorage.getItem(HL_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [showSnippets, setShowSnippets] = useState(false);
  const [pendingSend, setPendingSend] = useState<{ text: string; exec: boolean } | null>(null);
  const socketRef = useRef<TerminalSocket | null>(null);
  const highlightRef = useRef(highlight);
  // keep onExit in a ref so an unstable parent callback never re-triggers the
  // connect effect (which would tear down and re-open the session — flicker)
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const { data: snippetData } = useQuery({
    queryKey: ['snippets'],
    queryFn: () => api<{ snippets: Snippet[] }>('/snippets'),
  });

  /** Send text to the session — multi-line goes through a paste-guard confirm. */
  function sendToSession(text: string, exec: boolean) {
    if (/\r|\n/.test(text) && text.replace(/\s+$/, '').length > 0) {
      setPendingSend({ text, exec });
    } else {
      socketRef.current?.sendData(exec ? text.replace(/[\r\n]+$/, '') + '\r' : text);
    }
  }

  useEffect(() => {
    highlightRef.current = highlight;
    try {
      localStorage.setItem(HL_KEY, highlight ? '1' : '0');
    } catch {
      /* private mode */
    }
  }, [highlight]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    let disposed = false;
    const cleanups: Array<() => void> = [];

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

    // Coalesce resize callbacks to one fit per frame, and skip when the box
    // hasn't actually changed size — a fit() that runs on every ResizeObserver
    // tick can feed itself through xterm's own layout and flicker endlessly.
    let lastW = 0;
    let lastH = 0;
    let fitQueued = 0;
    const safeFit = () => {
      if (disposed || el.clientWidth === 0 || el.clientHeight === 0) return;
      if (el.clientWidth === lastW && el.clientHeight === lastH) return;
      lastW = el.clientWidth;
      lastH = el.clientHeight;
      try {
        fit.fit();
      } catch {
        /* ignore transient layout errors */
      }
    };
    const queueFit = () => {
      if (fitQueued) return;
      fitQueued = requestAnimationFrame(() => {
        fitQueued = 0;
        safeFit();
      });
    };

    // Open the terminal only once its container has a real size — opening into a
    // zero-height box leaves the renderer without dimensions and the first byte
    // of output then throws inside xterm's Viewport.
    const boot = () => {
      if (disposed) return;
      if (el.clientWidth === 0 || el.clientHeight === 0) {
        const raf = requestAnimationFrame(boot);
        cleanups.push(() => cancelAnimationFrame(raf));
        return;
      }

      term.open(el);
      safeFit();

      const socket = new TerminalSocket(
        { connectionId, adhoc, cols: term.cols, rows: term.rows },
        {
          onData: (chunk) =>
            highlightRef.current ? term.write(colorizeChunk(new TextDecoder().decode(chunk))) : term.write(chunk),
          onStatus: (state, detail) => {
            setStatus(state);
            setStatusDetail(detail);
            if (state === 'ready') term.focus();
            if (state === 'closed') {
              term.write(`\r\n\x1b[90m— session closed${detail ? `: ${detail}` : ''} —\x1b[0m\r\n`);
              onExitRef.current?.(detail ?? 'closed');
            }
          },
          onHostKey: (msg) => setHostKey(msg),
          onError: (message) => term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`),
          onToken: (token) => tabsRef.current.setToken(tabKey, token),
        },
        tabsRef.current.getToken(tabKey),
      );
      socketRef.current = socket;
      socket.connect();
      cleanups.push(tabsRef.current.registerSink(tabKey, { sendData: (s) => socket.sendData(s) }));

      const disposeData = term.onData((d) => {
        socket.sendData(d);
        if (broadcastRef.current) tabsRef.current.fanoutInput(tabKey, d);
      });
      const disposeResize = term.onResize(({ cols, rows }) => socket.resize(cols, rows));
      const ro = new ResizeObserver(queueFit);
      ro.observe(el);
      const ping = setInterval(() => socket.send({ t: 'ping' }), 25_000);

      // Paste guard: intercept multi-line pastes before xterm sends them.
      const onPaste = (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData('text') ?? '';
        if (/\r|\n/.test(text.trim()) && text.length > 8) {
          e.preventDefault();
          e.stopPropagation();
          setPendingSend({ text, exec: false });
        }
      };
      el.addEventListener('paste', onPaste, true);

      cleanups.push(() => {
        clearInterval(ping);
        ro.disconnect();
        if (fitQueued) cancelAnimationFrame(fitQueued);
        el.removeEventListener('paste', onPaste, true);
        disposeData.dispose();
        disposeResize.dispose();
        socket.close();
      });
    };

    // Defer the actual connect one tick so React 18 StrictMode's mount→unmount→
    // mount in dev doesn't open (and immediately tear down) a real SSH session.
    const bootTimer = setTimeout(boot, 0);

    return () => {
      disposed = true;
      clearTimeout(bootTimer);
      cleanups.forEach((fn) => fn());
      term.dispose();
    };
  }, [tabKey, connectionId, adhoc]);

  return (
    <div className="terminal-wrap">
      <div className="term-status">
        {status === 'connecting' && (
          <>
            <Badge tone="info" dot>
              Connecting
            </Badge>
            {statusDetail && <span className="muted">{statusDetail}</span>}
          </>
        )}
        {status === 'ready' && (
          <Badge tone="up" dot>
            Up
          </Badge>
        )}
        {status === 'closed' && (
          <>
            <Badge tone="down" dot>
              Down
            </Badge>
            {statusDetail && <span className="muted">{statusDetail}</span>}
          </>
        )}
        <span className="spacer" />
        {(snippetData?.snippets.length ?? 0) > 0 && (
          <div className="snippet-menu">
            <button className="btn ghost sm" onClick={() => setShowSnippets((s) => !s)}>
              Snippets ▾
            </button>
            {showSnippets && (
              <div className="snippet-list" onMouseLeave={() => setShowSnippets(false)}>
                {snippetData!.snippets.map((s) => (
                  <button
                    key={s.id}
                    className="snippet-item"
                    onClick={() => {
                      sendToSession(s.command, true);
                      setShowSnippets(false);
                    }}
                    title={s.command}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          className={`btn ghost sm ${highlight ? 'toggle-on' : ''}`}
          title="Colour UP / DOWN / VLAN keywords in output (does not affect interactive apps)"
          onClick={() => setHighlight((v) => !v)}
        >
          Highlight {highlight ? 'on' : 'off'}
        </button>
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
      {pendingSend && (
        <div className="overlay" onClick={() => setPendingSend(null)}>
          <div className="card hostkey" onClick={(e) => e.stopPropagation()}>
            <h2>
              <Badge tone="warn">Paste guard</Badge>
              Send {pendingSend.text.split(/\r?\n/).length} lines to this session?
            </h2>
            <p className="muted small">Pasting a partial config into a device can be disruptive. Review it first.</p>
            <pre className="paste-preview">{pendingSend.text.slice(0, 2000)}</pre>
            <div className="row end gap">
              <button className="btn ghost" onClick={() => setPendingSend(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  socketRef.current?.sendData(pendingSend.text);
                  setPendingSend(null);
                }}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
