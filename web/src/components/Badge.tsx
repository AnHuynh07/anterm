import type { ReactNode } from 'react';

export type BadgeTone = 'up' | 'down' | 'warn' | 'info' | 'neutral';

/**
 * Small colour-coded status pill. Use for anything the eye should scan quickly:
 * connection state (UP / DOWN), test results, auth types, VLAN-style tags.
 */
export function Badge({
  tone = 'neutral',
  children,
  dot = false,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}

/** Map a free-text status/exit-reason to a tone (handy for audit text). */
export function statusTone(text: string | null | undefined): BadgeTone {
  const s = (text ?? '').toLowerCase();
  // real failures
  if (/(denied|refused|unreachable|timeout|timed out|rejected|host key|auth\w* fail|unauthor|error)/.test(s))
    return 'down';
  if (/(changed|unknown|idle|expired|warn)/.test(s)) return 'warn';
  if (/(connecting|pending)/.test(s)) return 'info';
  if (/\b(up|connected|ready|ok|authenticated|success|active)\b/.test(s)) return 'up';
  // plain "closed" / "websocket closed" / "client disconnected" → nothing alarming
  return 'neutral';
}
