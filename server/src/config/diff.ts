export interface DiffLine {
  type: ' ' | '-' | '+' | '@';
  text: string;
}

const MAX_LINES = 6000;

/** Line-level diff of two configs. Collapses long unchanged runs to a marker. */
export function configDiff(a: string, b: string, context = 3): DiffLine[] {
  const A = a.replace(/\r\n/g, '\n').split('\n');
  const B = b.replace(/\r\n/g, '\n').split('\n');
  const raw = A.length > MAX_LINES || B.length > MAX_LINES ? setDiff(A, B) : lcsDiff(A, B);
  return collapse(raw, context);
}

function lcsDiff(A: string[], B: string[]): DiffLine[] {
  const n = A.length;
  const m = B.length;
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: ' ', text: A[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: '-', text: A[i++]! });
    } else {
      out.push({ type: '+', text: B[j++]! });
    }
  }
  while (i < n) out.push({ type: '-', text: A[i++]! });
  while (j < m) out.push({ type: '+', text: B[j++]! });
  return out;
}

/** cheap fallback for huge files: order-independent set difference */
function setDiff(A: string[], B: string[]): DiffLine[] {
  const bSet = new Set(B);
  const aSet = new Set(A);
  const out: DiffLine[] = [];
  for (const line of A) if (!bSet.has(line)) out.push({ type: '-', text: line });
  for (const line of B) if (!aSet.has(line)) out.push({ type: '+', text: line });
  if (!out.length) out.push({ type: ' ', text: '(configs are identical)' });
  return out;
}

function collapse(lines: DiffLine[], context: number): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.type === '-' || lines[i]!.type === '+') {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
    }
  }
  const out: DiffLine[] = [];
  let hidden = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (hidden) {
        out.push({ type: '@', text: `⋯ ${hidden} unchanged line${hidden > 1 ? 's' : ''} ⋯` });
        hidden = 0;
      }
      out.push(lines[i]!);
    } else {
      hidden++;
    }
  }
  if (hidden) out.push({ type: '@', text: `⋯ ${hidden} unchanged line${hidden > 1 ? 's' : ''} ⋯` });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === '+') added++;
    else if (l.type === '-') removed++;
  }
  return { added, removed };
}
