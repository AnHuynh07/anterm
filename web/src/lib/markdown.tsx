import type { ReactNode } from 'react';

/**
 * Tiny, dependency-free Markdown renderer for per-device runbooks. Handles the
 * subset operators actually use: headings, bold/italic/code, links, fenced code
 * blocks, blockquotes, ordered/unordered lists, horizontal rules. Everything is
 * built as React elements — no `dangerouslySetInnerHTML`, no HTML passthrough —
 * so a runbook can never inject markup.
 */
export function renderMarkdown(src: string): ReactNode {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const at = (n: number): string => lines[n] ?? '';
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => `md${key++}`;

  while (i < lines.length) {
    const line = at(i);

    // fenced code block
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(at(i))) body.push(at(i++));
      if (i < lines.length) i++; // closing fence
      blocks.push(
        <pre key={k()} className="md-pre">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // blank line
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={k()} className="md-hr" />);
      i++;
      continue;
    }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = (h[1] ?? '#').length;
      const Tag = (['h3', 'h3', 'h4', 'h5'][level - 1] ?? 'h5') as 'h3' | 'h4' | 'h5';
      blocks.push(
        <Tag key={k()} className={`md-h md-h${level}`}>
          {renderInline(h[2] ?? '')}
        </Tag>,
      );
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(at(i))) body.push(at(i++).replace(/^\s*>\s?/, ''));
      blocks.push(
        <blockquote key={k()} className="md-quote">
          {renderMarkdown(body.join('\n'))}
        </blockquote>,
      );
      continue;
    }

    // list (ordered or unordered)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(at(i))) {
        items.push(at(i++).replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      }
      const li = items.map((t) => <li key={k()}>{renderInline(t)}</li>);
      blocks.push(
        ordered ? (
          <ol key={k()} className="md-list">
            {li}
          </ol>
        ) : (
          <ul key={k()} className="md-list">
            {li}
          </ul>
        ),
      );
      continue;
    }

    // paragraph — gather until blank / block start
    const para: string[] = [];
    while (i < lines.length) {
      const l = at(i);
      if (
        /^\s*$/.test(l) ||
        /^\s*```/.test(l) ||
        /^#{1,4}\s+/.test(l) ||
        /^\s*>\s?/.test(l) ||
        /^\s*([-*+]|\d+[.)])\s+/.test(l)
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    blocks.push(
      <p key={k()} className="md-p">
        {renderInline(para.join(' '))}
      </p>,
    );
  }

  return blocks;
}

/** Inline spans: `code`, **bold**, *italic* / _italic_, [text](url). */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)\s]+\))/;
  let rest = text;
  let key = 0;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    const tok = m[0];
    if (m.index > 0) out.push(rest.slice(0, m.index));
    if (tok.startsWith('`')) {
      out.push(
        <code key={key++} className="md-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**')) {
      out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('[')) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const label = lm?.[1] ?? tok;
      const target = lm?.[2] ?? '';
      const href = /^https?:\/\//i.test(target) ? target : '#';
      out.push(
        <a key={key++} href={href} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    } else {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}
