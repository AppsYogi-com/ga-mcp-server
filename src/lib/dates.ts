/**
 * Date ranges, computed in the property's time zone. After "today" is known, all arithmetic is
 * done on UTC calendar dates (YYYY-MM-DD) so daylight-saving changes can't shift a day.
 */

export const DATE_PRESETS = ['last7d', 'last28d', 'last90d', 'last365d', 'this_month', 'last_month'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];
export type CompareMode = 'previous_period' | 'previous_year' | 'none';

export interface DateRange {
    name?: string;
    startDate: string;
    endDate: string;
}

export interface DateInput {
    dateRange?: DatePreset;
    startDate?: string;
    endDate?: string;
}

export class DateInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DateInputError';
    }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date (YYYY-MM-DD) in an IANA time zone. */
export function todayIn(timeZone: string | undefined, now: Date = new Date()): string {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: timeZone || 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(now);
    } catch {
        return now.toISOString().slice(0, 10);
    }
}

function parseIso(date: string): Date {
    if (!ISO_DATE.test(date)) throw new DateInputError(`Invalid date "${date}". Use YYYY-MM-DD.`);
    const d = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
        throw new DateInputError(`Invalid date "${date}".`);
    }
    return d;
}

/** Add (or subtract) whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
    const d = parseIso(date);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** Inclusive number of days in a range. */
export function daysInRange(range: DateRange): number {
    return Math.round((parseIso(range.endDate).getTime() - parseIso(range.startDate).getTime()) / 86_400_000) + 1;
}

/** Turn GA relative dates (today, yesterday, NdaysAgo) or YYYY-MM-DD into YYYY-MM-DD. */
export function resolveDate(value: string, today: string): string {
    const v = value.trim();
    if (v === 'today') return today;
    if (v === 'yesterday') return addDays(today, -1);
    const ago = /^(\d+)daysAgo$/.exec(v);
    if (ago) return addDays(today, -Number(ago[1]));
    parseIso(v);
    return v;
}

function presetRange(preset: DatePreset, today: string): DateRange {
    const yesterday = addDays(today, -1);
    switch (preset) {
        case 'last7d':
            return { startDate: addDays(yesterday, -6), endDate: yesterday };
        case 'last28d':
            return { startDate: addDays(yesterday, -27), endDate: yesterday };
        case 'last90d':
            return { startDate: addDays(yesterday, -89), endDate: yesterday };
        case 'last365d':
            return { startDate: addDays(yesterday, -364), endDate: yesterday };
        case 'this_month':
            return { startDate: `${today.slice(0, 7)}-01`, endDate: today };
        case 'last_month': {
            const firstOfThisMonth = `${today.slice(0, 7)}-01`;
            const lastOfPrev = addDays(firstOfThisMonth, -1);
            return { startDate: `${lastOfPrev.slice(0, 7)}-01`, endDate: lastOfPrev };
        }
    }
}

/**
 * Resolve the tool's date input into a concrete range. Default: the last 28 complete days
 * (ending yesterday) in the property's time zone.
 */
export function resolveDateRange(input: DateInput, timeZone: string | undefined, now: Date = new Date()): DateRange {
    const today = todayIn(timeZone, now);
    if (input.startDate || input.endDate) {
        if (input.dateRange) throw new DateInputError('Use either dateRange or startDate/endDate, not both.');
        const endDate = resolveDate(input.endDate ?? 'yesterday', today);
        const startDate = input.startDate ? resolveDate(input.startDate, today) : addDays(endDate, -27);
        if (startDate > endDate) throw new DateInputError(`startDate ${startDate} is after endDate ${endDate}.`);
        return { startDate, endDate };
    }
    return presetRange(input.dateRange ?? 'last28d', today);
}

/** The last `days` complete days (ending yesterday) in a time zone. */
export function lastDays(days: number, timeZone: string | undefined, now: Date = new Date()): DateRange {
    const yesterday = addDays(todayIn(timeZone, now), -1);
    return { startDate: addDays(yesterday, -(days - 1)), endDate: yesterday };
}

/** The range immediately before, with the same number of days. */
export function previousPeriod(range: DateRange): DateRange {
    const days = daysInRange(range);
    const endDate = addDays(range.startDate, -1);
    return { startDate: addDays(endDate, -(days - 1)), endDate };
}

/** The same range one year earlier, shifted 364 days so weekdays line up. */
export function previousYear(range: DateRange): DateRange {
    return { startDate: addDays(range.startDate, -364), endDate: addDays(range.endDate, -364) };
}

/** The comparison range for a compare mode, or undefined for "none". */
export function comparisonRange(range: DateRange, mode: CompareMode | undefined): DateRange | undefined {
    if (mode === 'previous_period') return previousPeriod(range);
    if (mode === 'previous_year') return previousYear(range);
    return undefined;
}

/** True when the range includes today in the property's time zone (data still being collected). */
export function includesToday(range: DateRange, timeZone: string | undefined, now: Date = new Date()): boolean {
    const today = todayIn(timeZone, now);
    return range.startDate <= today && range.endDate >= today;
}
