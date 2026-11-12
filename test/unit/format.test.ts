import { describe, expect, it } from 'vitest';
import { addUrlKeys, fmt, fmtChange, parseMetric, parseReport, pctChange, ratio, shapeRows } from '../../src/lib/format.js';
import { mergeRows } from '../../src/lib/merge.js';
import { parseQuota, quotaWarnings } from '../../src/lib/quota.js';
import { metadataWarnings, todayWarning, uniqueWarnings } from '../../src/lib/warnings.js';

const response = {
    dimensionHeaders: [{ name: 'hostName' }, { name: 'pagePath' }],
    metricHeaders: [
        { name: 'sessions', type: 'TYPE_INTEGER' },
        { name: 'engagementRate', type: 'TYPE_FLOAT' },
        { name: 'userEngagementDuration', type: 'TYPE_SECONDS' },
    ],
    rows: [
        { dimensionValues: [{ value: 'www.example.com' }, { value: '/blog/' }], metricValues: [{ value: '120' }, { value: '0.61234' }, { value: '3456.789' }] },
        { dimensionValues: [{ value: 'example.com' }, { value: '/blog' }], metricValues: [{ value: '30' }, { value: '0.5' }, { value: '100' }] },
        { dimensionValues: [{ value: 'example.com' }, { value: '(not set)' }], metricValues: [{ value: '5' }, { value: '0' }, { value: '0' }] },
    ],
    totals: [{ dimensionValues: [{ value: 'RESERVED_TOTAL' }, { value: 'RESERVED_TOTAL' }], metricValues: [{ value: '155' }, { value: '0.6' }, { value: '3556.789' }] }],
    rowCount: 3,
};

describe('parseReport', () => {
    it('types and rounds metric values', () => {
        const parsed = parseReport(response);
        expect(parsed.dimensions).toEqual(['hostName', 'pagePath']);
        expect(parsed.rows[0]).toEqual({ hostName: 'www.example.com', pagePath: '/blog/', sessions: 120, engagementRate: 0.6123, userEngagementDuration: 3456.8 });
        expect(parsed.totals.total).toEqual({ sessions: 155, engagementRate: 0.6, userEngagementDuration: 3556.8 });
        expect(parsed.rowCount).toBe(3);
    });

    it('keys totals by date range when there are several', () => {
        const parsed = parseReport({
            dimensionHeaders: [{ name: 'dateRange' }],
            metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }],
            rows: [],
            totals: [
                { dimensionValues: [{ value: 'current' }], metricValues: [{ value: '10' }] },
                { dimensionValues: [{ value: 'previous' }], metricValues: [{ value: '8' }] },
            ],
        });
        expect(parsed.totals).toEqual({ current: { sessions: 10 }, previous: { sessions: 8 } });
    });

    it('handles empty responses', () => {
        expect(parseReport({})).toEqual({ dimensions: [], metrics: [], rows: [], totals: {}, rowCount: 0 });
    });

    it.each([
        ['12.6', 'TYPE_INTEGER', 13],
        ['1.23456', 'TYPE_FLOAT', 1.2346],
        ['12.345', 'TYPE_CURRENCY', 12.35],
        ['', 'TYPE_INTEGER', null],
        ['NaN', 'TYPE_FLOAT', null],
    ])('parseMetric(%s, %s) = %s', (raw, type, expected) => {
        expect(parseMetric(raw, type)).toBe(expected);
    });
});

describe('addUrlKeys', () => {
    it('builds url_key from hostName + path and merges trailing-slash variants', () => {
        const parsed = parseReport(response);
        const rows = addUrlKeys(parsed.rows, parsed.dimensions);
        expect(rows.map((r) => r.url_key)).toEqual(['example.com/blog', 'example.com/blog', null]);
        const merged = mergeRows(rows, (r) => r.url_key as string | null, ['sessions', 'engagementRate'], ['url_key']);
        expect(merged.rows).toEqual([{ url_key: 'example.com/blog', sessions: 150 }]);
        expect(merged.approximateUsers).toBe(false);
    });

    it('uses the default host when there is no hostName dimension', () => {
        const rows = addUrlKeys([{ landingPage: '/start' }], ['landingPage'], 'shop.example.com');
        expect(rows[0].url_key).toBe('shop.example.com/start');
    });

    it('needs no host for full URL dimensions', () => {
        const rows = addUrlKeys([{ fullPageUrl: 'www.example.com/a/?x=1' }], ['fullPageUrl']);
        expect(rows[0].url_key).toBe('example.com/a');
    });

    it('leaves rows without page dimensions untouched', () => {
        const rows = [{ country: 'India', sessions: 3 }];
        expect(addUrlKeys(rows, ['country'])).toBe(rows);
    });
});

describe('mergeRows', () => {
    it('flags summed user counts as approximate', () => {
        const merged = mergeRows(
            [{ k: 'a', totalUsers: 5 }, { k: 'a', totalUsers: 7 }],
            (r) => r.k as string,
            ['totalUsers'],
            ['k'],
        );
        expect(merged.rows).toEqual([{ k: 'a', totalUsers: 12 }]);
        expect(merged.approximateUsers).toBe(true);
    });
});

describe('number helpers', () => {
    it('computes changes and ratios safely', () => {
        expect(pctChange(120, 100)).toBe(20);
        expect(pctChange(80, 100)).toBe(-20);
        expect(pctChange(5, 0)).toBeNull();
        expect(pctChange(null, 3)).toBeNull();
        expect(ratio(1, 3)).toBe(0.3333);
        expect(ratio(1, 0)).toBeNull();
    });

    it('formats for summaries', () => {
        expect(fmt(12345.6, 'int')).toBe('12,346');
        expect(fmt(0.4567, 'pct')).toBe('45.7%');
        expect(fmt(12.34, 'sec')).toBe('12.3s');
        expect(fmt(null)).toBe('n/a');
        expect(fmtChange(12.5)).toBe('+12.5%');
        expect(fmtChange(-3)).toBe('-3%');
        expect(fmtChange(null)).toBe('n/a');
    });

    it('shapes rows as compact arrays or full objects', () => {
        const rows = [{ a: 1, b: 'x' }, { a: 2, b: null }];
        expect(shapeRows(rows, 'compact')).toEqual({ columns: ['a', 'b'], rows: [[1, 'x'], [2, null]] });
        expect(shapeRows(rows, 'full')).toEqual({ rows });
        expect(shapeRows([], 'compact')).toEqual({ columns: [], rows: [] });
    });
});

describe('quota', () => {
    const quota = {
        tokensPerDay: { consumed: 199_000, remaining: 1_000 },
        tokensPerHour: { consumed: 100, remaining: 39_900 },
        tokensPerProjectPerHour: { consumed: 10, remaining: 13_990 },
        concurrentRequests: { consumed: 0, remaining: 10 },
    };

    it('summarizes remaining tokens', () => {
        expect(parseQuota(quota)).toEqual({ tokens_today_left: 1000, tokens_hour_left: 39900, project_tokens_hour_left: 13990, concurrent_requests_left: 10 });
        expect(parseQuota(null)).toBeNull();
    });

    it('warns when a bucket is nearly empty', () => {
        expect(quotaWarnings(quota)).toEqual(['Only 1000 of 200000 daily GA4 quota tokens left for this property.']);
        expect(quotaWarnings(undefined)).toEqual([]);
    });
});

describe('warnings', () => {
    it('reports thresholding, sampling, (other) rows and empty data', () => {
        expect(metadataWarnings({
            subjectToThresholding: true,
            samplingMetadatas: [{ samplesReadCount: '250', samplingSpaceSize: '1000' }],
            dataLossFromOtherRow: true,
            emptyReason: 'No data for this date range',
        })).toEqual([
            expect.stringContaining('thresholding'),
            'Sampled data: based on 25% of events.',
            expect.stringContaining('(other)'),
            'No data: No data for this date range',
        ]);
        expect(metadataWarnings(null)).toEqual([]);
    });

    it('warns about ranges that include today, without duplicates', () => {
        const now = new Date('2026-03-01T12:00:00Z');
        const w = todayWarning([{ startDate: '2026-02-01', endDate: '2026-03-01' }], 'UTC', now);
        expect(w).toHaveLength(1);
        expect(uniqueWarnings(w, w, ['x'])).toEqual([w[0], 'x']);
    });
});
