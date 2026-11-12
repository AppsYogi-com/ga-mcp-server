import { describe, expect, it } from 'vitest';
import {
    addDays, comparisonRange, DateInputError, daysInRange, includesToday, previousPeriod, previousYear, resolveDate,
    resolveDateRange, todayIn,
} from '../../src/lib/dates.js';

// 2026-03-01T03:30:00Z: still Feb 28 in Los Angeles, already Mar 1 in Kolkata.
const NOW = new Date('2026-03-01T03:30:00Z');

describe('todayIn', () => {
    it('uses the property time zone', () => {
        expect(todayIn('America/Los_Angeles', NOW)).toBe('2026-02-28');
        expect(todayIn('Asia/Kolkata', NOW)).toBe('2026-03-01');
        expect(todayIn(undefined, NOW)).toBe('2026-03-01');
    });

    it('falls back to UTC for an unknown time zone', () => {
        expect(todayIn('Not/AZone', NOW)).toBe('2026-03-01');
    });
});

describe('date arithmetic', () => {
    it('adds days across month, year and leap-day boundaries', () => {
        expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
        expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
        expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    });

    it('counts inclusive days', () => {
        expect(daysInRange({ startDate: '2026-01-01', endDate: '2026-01-28' })).toBe(28);
        expect(daysInRange({ startDate: '2026-01-01', endDate: '2026-01-01' })).toBe(1);
    });

    it('resolves GA relative dates', () => {
        expect(resolveDate('today', '2026-03-01')).toBe('2026-03-01');
        expect(resolveDate('yesterday', '2026-03-01')).toBe('2026-02-28');
        expect(resolveDate('30daysAgo', '2026-03-01')).toBe('2026-01-30');
        expect(resolveDate('2026-01-05', '2026-03-01')).toBe('2026-01-05');
        expect(() => resolveDate('2026-02-30', '2026-03-01')).toThrowError(DateInputError);
        expect(() => resolveDate('last week', '2026-03-01')).toThrowError(DateInputError);
    });
});

describe('resolveDateRange', () => {
    it('defaults to the last 28 complete days in the property time zone', () => {
        expect(resolveDateRange({}, 'Asia/Kolkata', NOW)).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' });
        expect(resolveDateRange({}, 'America/Los_Angeles', NOW)).toEqual({ startDate: '2026-01-31', endDate: '2026-02-27' });
    });

    it.each([
        ['last7d', { startDate: '2026-02-22', endDate: '2026-02-28' }],
        ['last90d', { startDate: '2025-12-01', endDate: '2026-02-28' }],
        ['last365d', { startDate: '2025-03-01', endDate: '2026-02-28' }],
        ['this_month', { startDate: '2026-03-01', endDate: '2026-03-01' }],
        ['last_month', { startDate: '2026-02-01', endDate: '2026-02-28' }],
    ] as const)('preset %s', (preset, expected) => {
        expect(resolveDateRange({ dateRange: preset }, 'Asia/Kolkata', NOW)).toEqual(expected);
    });

    it('accepts explicit and relative start/end dates', () => {
        expect(resolveDateRange({ startDate: '2026-01-01', endDate: '2026-01-31' }, 'UTC', NOW)).toEqual({ startDate: '2026-01-01', endDate: '2026-01-31' });
        expect(resolveDateRange({ startDate: '7daysAgo', endDate: 'yesterday' }, 'UTC', NOW)).toEqual({ startDate: '2026-02-22', endDate: '2026-02-28' });
        expect(resolveDateRange({ endDate: '2026-02-10' }, 'UTC', NOW)).toEqual({ startDate: '2026-01-14', endDate: '2026-02-10' });
    });

    it('rejects conflicting or reversed input', () => {
        expect(() => resolveDateRange({ dateRange: 'last7d', startDate: '2026-01-01' }, 'UTC', NOW)).toThrowError(/either dateRange/);
        expect(() => resolveDateRange({ startDate: '2026-02-10', endDate: '2026-02-01' }, 'UTC', NOW)).toThrowError(/after endDate/);
    });
});

describe('comparison ranges', () => {
    const range = { startDate: '2026-02-01', endDate: '2026-02-28' };

    it('previous period has the same length, immediately before', () => {
        expect(previousPeriod(range)).toEqual({ startDate: '2026-01-04', endDate: '2026-01-31' });
        expect(daysInRange(previousPeriod(range))).toBe(28);
    });

    it('previous year is 364 days back so weekdays line up', () => {
        const prev = previousYear(range);
        expect(prev).toEqual({ startDate: '2025-02-02', endDate: '2025-03-01' });
        expect(new Date(`${prev.startDate}T00:00:00Z`).getUTCDay()).toBe(new Date(`${range.startDate}T00:00:00Z`).getUTCDay());
    });

    it('comparisonRange maps modes', () => {
        expect(comparisonRange(range, 'previous_period')).toEqual(previousPeriod(range));
        expect(comparisonRange(range, 'previous_year')).toEqual(previousYear(range));
        expect(comparisonRange(range, 'none')).toBeUndefined();
        expect(comparisonRange(range, undefined)).toBeUndefined();
    });

    it('detects ranges that include today', () => {
        expect(includesToday({ startDate: '2026-02-01', endDate: '2026-03-01' }, 'Asia/Kolkata', NOW)).toBe(true);
        expect(includesToday({ startDate: '2026-02-01', endDate: '2026-02-28' }, 'Asia/Kolkata', NOW)).toBe(false);
    });
});
