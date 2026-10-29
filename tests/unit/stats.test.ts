import { describe, expect, it } from 'vitest';
import { localDateKey, pruneStats, recordStat, statsForDay } from '../../src/core/stats';

describe('stats', () => {
  it('uses the local calendar date', () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDateKey(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });

  it('adds events to the day they happen on', () => {
    const lateNight = new Date(2026, 9, 28, 23, 59, 59);
    const nextMorning = new Date(2026, 9, 29, 0, 0, 1);
    let stats = recordStat({}, 'shown', lateNight);
    stats = recordStat(stats, 'opened', nextMorning);
    stats = recordStat(stats, 'declined', nextMorning);
    expect(statsForDay(stats, '2026-10-28')).toEqual({ date: '2026-10-28', shown: 1, opened: 0, declined: 0 });
    expect(statsForDay(stats, '2026-10-29')).toEqual({ date: '2026-10-29', shown: 0, opened: 1, declined: 1 });
  });

  it('returns an empty day when nothing happened', () => {
    expect(statsForDay({}, '2026-10-29')).toEqual({ date: '2026-10-29', shown: 0, opened: 0, declined: 0 });
  });

  it('keeps roughly the last 90 days', () => {
    const today = new Date(2026, 9, 29);
    const stats = {
      '2026-07-31': { date: '2026-07-31', shown: 1, opened: 0, declined: 0 },
      '2026-08-01': { date: '2026-08-01', shown: 2, opened: 0, declined: 0 },
      '2026-10-29': { date: '2026-10-29', shown: 3, opened: 0, declined: 0 },
    };
    expect(Object.keys(pruneStats(stats, today))).toEqual(['2026-08-01', '2026-10-29']);
  });
});
