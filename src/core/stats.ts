import type { DailyStats, StatKind, StatsMap } from './types';

export const STATS_RETENTION_DAYS = 90;

/** Local calendar date of the device, YYYY-MM-DD. */
export function localDateKey(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function emptyDay(date: string): DailyStats {
  return { date, shown: 0, opened: 0, declined: 0 };
}

export function statsForDay(stats: StatsMap, date: string): DailyStats {
  return stats[date] ?? emptyDay(date);
}

/** Returns a new map with one event added on the event's local date, older days pruned. */
export function recordStat(stats: StatsMap, kind: StatKind, at: Date): StatsMap {
  const date = localDateKey(at);
  const day = statsForDay(stats, date);
  return pruneStats({ ...stats, [date]: { ...day, [kind]: day[kind] + 1 } }, at);
}

export function pruneStats(stats: StatsMap, today: Date, keepDays = STATS_RETENTION_DAYS): StatsMap {
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (keepDays - 1));
  const cutoffKey = localDateKey(cutoff);
  const result: StatsMap = {};
  for (const [date, day] of Object.entries(stats)) {
    if (date >= cutoffKey) result[date] = day;
  }
  return result;
}
