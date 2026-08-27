import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { API_BASE } from '../lib/api';

type Ev = [number, string];

const THEME = { background: '#242329', foreground: '#e7e4dd', cursor: '#d9a1a7' };
const SPEEDS = [1, 2, 4, 8];

export function SessionReplay({ sessionId, target, onClose }: { sessionId: string; target: string; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const eventsRef = useRef<Ev[]>([]);
  const idxRef = useRef(0);
  const rafRef = useRef<number>(0);
  const lastTickRef = useRef(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [duration, setDuration] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  // build the terminal once
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: THEME,
      scrollback: 10_000,
      disableStdin: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    setTimeout(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    }, 0);
    termRef.current = term;
    return () => term.dispose();
  }, []);

  // load the cast
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/recording`, { credentials: 'include' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `load failed (${res.status})`);
        const text = await res.text();
        if (cancelled) return;
        const lines = text.split('\n');
        const evs: Ev[] = [];
        for (const line of lines.slice(1)) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line) as [number, string, string];
            if (e[1] === 'o') evs.push([e[0], e[2]]);
          } catch {
            /* skip */
          }
        }
        eventsRef.current = evs;
        setDuration(evs.length ? evs[evs.length - 1]![0] : 0);
        setLoading(false);
        seekTo(0);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  function writeUpTo(t: number) {
    const term = termRef.current;
    if (!term) return;
    const evs = eventsRef.current;
    while (idxRef.current < evs.length && evs[idxRef.current]![0] <= t) {
      term.write(evs[idxRef.current]![1]);
      idxRef.current++;
    }
  }

  function seekTo(t: number) {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    idxRef.current = 0;
    writeUpTo(t);
    setElapsed(t);
  }

  function tick(now: number) {
    const dt = (now - lastTickRef.current) / 1000;
    lastTickRef.current = now;
    setElapsed((prev) => {
      const next = prev + dt * speed;
      writeUpTo(next);
      if (next >= duration) {
        setPlaying(false);
        return duration;
      }
      return next;
    });
    rafRef.current = requestAnimationFrame(tick);
  }

  useEffect(() => {
    if (!playing) return;
    if (elapsed >= duration) seekTo(0);
    lastTickRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>Replay · {target}</h2>
          <button className="btn ghost sm" onClick={onClose}>
            Close
          </button>
        </div>
        {loading && <p className="muted">Loading recording…</p>}
        {error && <div className="alert error">{error}</div>}
        <div className="replay-term" ref={hostRef} style={{ display: loading || error ? 'none' : 'block' }} />
        {!loading && !error && (
          <div className="replay-controls">
            <button className="btn sm" onClick={() => setPlaying((p) => !p)}>
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button
              className="btn ghost sm"
              onClick={() => {
                setPlaying(false);
                seekTo(0);
              }}
            >
              ↻ Restart
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.1}
              value={elapsed}
              onChange={(e) => {
                setPlaying(false);
                seekTo(Number(e.target.value));
              }}
            />
            <span className="mono small">
              {fmt(elapsed)} / {fmt(duration)}
            </span>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
            <a className="btn ghost sm" href={`${API_BASE}/sessions/${sessionId}/recording.txt`} target="_blank" rel="noreferrer">
              .txt
            </a>
            <a className="btn ghost sm" href={`${API_BASE}/sessions/${sessionId}/recording`} download={`${sessionId}.cast`}>
              .cast
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
