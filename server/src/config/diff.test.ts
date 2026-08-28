import { describe, expect, it } from 'vitest';
import { configDiff, diffStats } from './diff.js';
import { isConfigSaveCommand } from './snapshots.js';

describe('configDiff', () => {
  it('reports no changes for identical input', () => {
    const d = configDiff('a\nb\nc', 'a\nb\nc');
    expect(diffStats(d)).toEqual({ added: 0, removed: 0 });
    expect(d.every((l) => l.type === ' ' || l.type === '@')).toBe(true);
  });

  it('flags added and removed lines', () => {
    const a = ['hostname sw1', 'interface Gi0/1', ' description uplink', ' switchport mode trunk', 'end'].join('\n');
    const b = ['hostname sw1', 'interface Gi0/1', ' description CORE-uplink', ' switchport mode trunk', ' shutdown', 'end'].join('\n');
    const d = configDiff(a, b);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
    expect(d.some((l) => l.type === '-' && l.text.includes('description uplink'))).toBe(true);
    expect(d.some((l) => l.type === '+' && l.text.includes('CORE-uplink'))).toBe(true);
    expect(d.some((l) => l.type === '+' && l.text.trim() === 'shutdown')).toBe(true);
  });

  it('collapses long unchanged runs to a gap marker', () => {
    const base = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const a = base.join('\n');
    const b = [...base.slice(0, 39), 'line 39 CHANGED'].join('\n');
    const d = configDiff(a, b, 3);
    expect(d.some((l) => l.type === '@')).toBe(true);
    // only a small window is materialised
    expect(d.filter((l) => l.type === ' ').length).toBeLessThan(12);
  });
});

describe('isConfigSaveCommand', () => {
  it.each([
    ['write', true],
    ['wr', true],
    ['write memory', true],
    ['wr mem', true],
    ['copy running-config startup-config', true],
    ['copy run start', true],
    ['commit', true],
    ['write terminal', false],
    ['show running-config', false],
    ['configure terminal', false],
  ])('%s -> %s', (line, expected) => {
    expect(isConfigSaveCommand(line)).toBe(expected);
  });
});
