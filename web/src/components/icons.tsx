// Minimal inline icon set (24px grid, 2px stroke) so the app carries no icon-font
// dependency. Each entry is a list of SVG path `d` strings.
const ICONS: Record<string, string[]> = {
  dashboard: ['M3 3h8v8H3z', 'M13 3h8v8h-8z', 'M13 13h8v8h-8z', 'M3 13h8v8H3z'],
  connections: ['M4 5h16v6H4z', 'M4 13h16v6H4z', 'M7.5 8h.01', 'M7.5 16h.01'],
  credentials: ['M12 3l7 3v5c0 4.6-3 7.7-7 8.7-4-1-7-4.1-7-8.7V6z', 'M9.3 11.8l1.8 1.8 3.6-3.6'],
  terminal: ['M3 4h18v16H3z', 'M7 9l3 3-3 3', 'M13 15h4'],
  history: ['M12 7v5l3 2', 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z'],
  settings: [
    'M4 7h6', 'M14 7h6', 'M4 12h10', 'M18 12h2', 'M4 17h4', 'M12 17h8',
    'M12 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    'M16 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    'M10 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  ],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
};

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  const paths = ICONS[name] ?? [];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
