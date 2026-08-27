/**
 * Optional client-side keyword colouring for terminal output — handy for
 * network gear where `show interface` / `show vlan` dumps are plain text.
 *
 * Only applied to chunks that contain no ESC (0x1b) bytes, so interactive
 * programs (vim, less, tmux, progress bars) are never touched.
 */

const GREEN = '\x1b[38;5;35m';
const RED = '\x1b[38;5;203m';
const YELLOW = '\x1b[38;5;179m';
const CYAN = '\x1b[38;5;38m';
const RESET = '\x1b[39m';

const RULES: Array<[RegExp, string]> = [
  [/\b(up|connected|active|enabled|reachable|permit|allowed|success|established)\b/gi, GREEN],
  [
    /\b(down|err-disabled|errdisable|notconnect|disabled|unreachable|deny|denied|drop(ped)?|fail(ed)?|timeout|refused|inactive|blocked)\b/gi,
    RED,
  ],
  [/\b(administratively down|shutdown|half-duplex|degraded|warning|standby)\b/gi, YELLOW],
  [/\b(vlan\s*\d+|trunk|access|native|tagged|untagged|port-channel\s*\d+)\b/gi, CYAN],
];

export function colorizeChunk(text: string): string {
  if (text.includes('\x1b')) return text;
  let out = text;
  for (const [re, color] of RULES) {
    out = out.replace(re, (m) => `${color}${m}${RESET}`);
  }
  return out;
}
