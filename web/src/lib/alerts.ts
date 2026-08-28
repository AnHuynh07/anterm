import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { ReachEvent } from '../types';

const SEEN_KEY = 'anterm.alerts.seen';

export function markAlertsSeen(ts: number) {
  try {
    localStorage.setItem(SEEN_KEY, String(ts));
  } catch {
    /* private mode / storage disabled */
  }
}

export function lastSeenAlert(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Recent UP/DOWN transitions across the caller's visible connections. */
export function useAlertEvents() {
  return useQuery({
    queryKey: ['health-events'],
    queryFn: () => api<{ events: ReachEvent[] }>('/connections/health/events?limit=40'),
    refetchInterval: 30_000,
  });
}
