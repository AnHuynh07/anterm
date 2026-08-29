import { describe, expect, it } from 'vitest';
import { htmlToText, parseFactsRules } from './facts.js';

describe('htmlToText', () => {
  it('flattens table rows so a label sits next to its value', () => {
    const t = htmlToText('<table><tr><td>Firmware</td><td>2.4.4</td></tr><tr><td>Model</td><td>AT-GS950</td></tr></table>');
    expect(t).toContain('Firmware 2.4.4');
    expect(t).toContain('Model AT-GS950');
  });

  it('drops scripts/styles and decodes basic entities', () => {
    const t = htmlToText('<style>x{}</style><script>evil()</script><p>A &amp; B &lt;ok&gt;</p>');
    expect(t).not.toContain('evil');
    expect(t).toBe('A & B <ok>');
  });
});

describe('parseFactsRules', () => {
  it('parses `Label = regex` lines and skips blanks / comments / bad regex', () => {
    const rules = parseFactsRules('# a comment\nFirmware = Runtime\\s+([0-9.]+)\n\nUptime=Up ?Time\\s*:?\\s*(.+)\nBad = (unclosed');
    expect(rules.map(([l]) => l)).toEqual(['Firmware', 'Uptime']);
    expect(rules[0]![1].source).toBe('Runtime\\s+([0-9.]+)');
    expect('Runtime  2.4.4'.match(rules[0]![1])?.[1]).toBe('2.4.4');
  });

  it('returns nothing for empty input', () => {
    expect(parseFactsRules(null)).toEqual([]);
    expect(parseFactsRules('   ')).toEqual([]);
  });
});
