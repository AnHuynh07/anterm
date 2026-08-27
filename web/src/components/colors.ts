import type { ConnectionColor } from '../types';

/** Display label + hex for each connection colour label (e.g. mark PROD red). */
export const COLOR_LABEL: Record<ConnectionColor, string> = {
  red: 'Red — production',
  amber: 'Amber — staging',
  green: 'Green — lab',
  blue: 'Blue',
  violet: 'Violet',
};

export const COLOR_HEX: Record<ConnectionColor, string> = {
  red: '#dc2626',
  amber: '#d97706',
  green: '#16a34a',
  blue: '#2563eb',
  violet: '#7c3aed',
};
