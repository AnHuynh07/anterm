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
  background: '#0f172a',
  foreground: '#e2e8f0',
  cursor: '#a5b4fc',
  selectionBackground: '#334155',
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchInfo, setSearchInfo] = useState<{ index: number; count: number }>({ index: -1, count: 0 });
  const socketRef = useRef<TerminalSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const highlightRef = useRef(highlight);
  // keep onExit in a ref so an unstable parent callback never re-triggers the
  // connect effect (which would tear down and re-open the session — flicker)
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const { data: snippetData } = useQuery({
    queryKey: ['snippets'],
    queryFn: () => api<{ snippets: Snippet[] }>('/snippets'),
  });

  const SEARCH_DECOR = {
    matchBackground: '#3730a3',
    matchBorder: '#818cf8',
    matchOverviewRuler: '#6366f1',
    activeMatchBackground: '#b45309',
    activeMatchBorder: '#fbbf24',
    activeMatchColorOverviewRuler: '#f59e0b',
  };
  function runSearch(dir: 'next' | 'prev', term = searchTerm) {
    if (!term) {
      searchRef.current?.clearDecorations();
      setSearchInfo({ index: -1, count: 0 });
      return;
    }
    const opts = { decorations: SEARCH_DECOR, incremental: dir === 'next' };
    if (dir === 'next') searchRef.current?.findNext(term, opts);
    else searchRef.current?.findPrevious(term, opts);
  }
  function closeSearch() {
    setSearchOpen(false);
    searchRef.current?.clearDecorations();
    setSearchInfo({ index: -1, count: 0 });
    termRef.current?.focus();
  }

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
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    term.loadAddon(new ClipboardAddon());
    searchRef.current = searchAddon;
    const disposeResults = searchAddon.onDidChangeResults((e) =>
      setSearchInfo({ index: e.resultIndex, count: e.resultCount }),
    );
    cleanups.push(() => disposeResults.dispose());

    // Ctrl/Cmd+Shift+F opens the scrollback finder
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.select(), 0);
        return false;
      }
      return true;
    });

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
      termRef.current = null;
      searchRef.current = null;
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
          className="btn ghost sm"
          title="Search the scrollback (Ctrl+Shift+F)"
          onClick={() => {
            setSearchOpen(true);
            setTimeout(() => searchInputRef.current?.select(), 0);
          }}
        >
          Find
        </button>
        <button
          className={`btn ghost sm ${highlight ? 'toggle-on' : ''}`}
          title="Colour UP / DOWN / VLAN keywords in output (does not affect interactive apps)"
          onClick={() => setHighlight((v) => !v)}
        >
          Highlight {highlight ? 'on' : 'off'}
        </button>
      </div>
      {searchOpen && (
        <div
          className="term-search"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              closeSearch();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runSearch(e.shiftKey ? 'prev' : 'next');
            }
          }}
        >
          <input
            ref={searchInputRef}
            value={searchTerm}
            placeholder="Find in scrollback…"
            autoFocus
            onChange={(e) => {
              setSearchTerm(e.target.value);
              runSearch('next', e.target.value);
            }}
          />
          <span className="muted small">
            {searchInfo.count ? `${searchInfo.index + 1}/${searchInfo.count}` : searchTerm ? '0/0' : ''}
          </span>
          <button className="btn ghost sm" title="Previous (Shift+Enter)" onClick={() => runSearch('prev')}>
            ↑
          </button>
          <button className="btn ghost sm" title="Next (Enter)" onClick={() => runSearch('next')}>
            ↓
          </button>
          <button className="btn ghost sm" title="Close (Esc)" onClick={closeSearch}>
            ✕
          </button>
        </div>
      )}
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
