/**
 * Turn GA4 Data API report responses into compact, typed rows for LLMs.
 */

import { FULL_URL_DIMENSIONS, PAGE_DIMENSIONS } from './fields.js';
import { toUrlKey } from './urlKey.js';

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;
export type OutputFormat = 'compact' | 'full';

interface GaValue { value?: string | null }
interface GaRow { dimensionValues?: GaValue[] | null; metricValues?: GaValue[] | null }
interface GaHeader { name?: string | null; type?: string | null }

/** The parts of a RunReportResponse / RunRealtimeReportResponse we use. */
export interface GaReportResponse {
    dimensionHeaders?: GaHeader[] | null;
    metricHeaders?: GaHeader[] | null;
    rows?: GaRow[] | null;
    totals?: GaRow[] | null;
    rowCount?: number | null;
    metadata?: Record<string, any> | null;
    propertyQuota?: Record<string, any> | null;
}

export interface ParsedReport {
    dimensions: string[];
    metrics: { name: string; type: string }[];
    rows: Row[];
    /** Totals keyed by date range name ("total" when there's a single range). */
    totals: Record<string, Row>;
    rowCount: number;
}

/** Round a number to a number of decimal places. */
export function round(value: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

/** Parse a metric value string according to its GA4 metric type. */
export function parseMetric(raw: string | null | undefined, type: string | undefined): number | null {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    switch (type) {
        case 'TYPE_INTEGER':
            return Math.round(n);
        case 'TYPE_SECONDS':
        case 'TYPE_MILLISECONDS':
        case 'TYPE_MINUTES':
        case 'TYPE_HOURS':
            return round(n, 1);
        case 'TYPE_CURRENCY':
            return round(n, 2);
        default:
            return round(n, 4);
    }
}

function parseRow(row: GaRow, dimensions: string[], metrics: { name: string; type: string }[]): Row {
    const out: Row = {};
    dimensions.forEach((d, i) => {
        out[d] = row.dimensionValues?.[i]?.value ?? null;
    });
    metrics.forEach((m, i) => {
        out[m.name] = parseMetric(row.metricValues?.[i]?.value, m.type);
    });
    return out;
}

/**
 * Header names, keeping only the first occurrence of each. GA4 funnel tables have been seen to
 * repeat every metric header (8 headers for 4 values); without this, the empty duplicates would
 * overwrite the real values.
 */
function firstOccurrences<T extends { name: string }>(headers: T[]): T[] {
    const seen = new Set<string>();
    return headers.filter((h) => (seen.has(h.name) ? false : (seen.add(h.name), true)));
}

/** Parse a GA4 report response into typed rows and totals. */
export function parseReport(response: GaReportResponse): ParsedReport {
    const dimensions = firstOccurrences((response.dimensionHeaders ?? []).map((h) => ({ name: h.name ?? '' }))).map((h) => h.name);
    const metrics = firstOccurrences((response.metricHeaders ?? []).map((h) => ({ name: h.name ?? '', type: h.type ?? 'TYPE_FLOAT' })));
    const rows = (response.rows ?? []).map((r) => parseRow(r, dimensions, metrics));
    const totals: Record<string, Row> = {};
    const dateRangeIndex = dimensions.indexOf('dateRange');
    for (const t of response.totals ?? []) {
        const parsed = parseRow(t, dimensions, metrics);
        const key = dateRangeIndex >= 0 ? String(t.dimensionValues?.[dateRangeIndex]?.value ?? 'total') : 'total';
        const metricsOnly: Row = {};
        for (const m of metrics) metricsOnly[m.name] = parsed[m.name];
        totals[key] = metricsOnly;
    }
    // GA4 omits totals when there are no rows; report zeros instead of nothing.
    if (rows.length === 0 && Object.keys(totals).length === 0 && metrics.length > 0) {
        totals.total = Object.fromEntries(metrics.map((m) => [m.name, 0]));
    }
    return { dimensions, metrics, rows, totals, rowCount: response.rowCount ?? rows.length };
}

/**
 * Add a `url_key` to rows that have a page dimension. Bare paths use the row's hostName,
 * or `defaultHost` when the report has no hostName dimension.
 */
export function addUrlKeys(rows: Row[], dimensions: string[], defaultHost?: string | null): Row[] {
    const pageDim = dimensions.find((d) => PAGE_DIMENSIONS.has(d));
    if (!pageDim) return rows;
    return rows.map((row) => {
        const value = row[pageDim];
        const host = (row.hostName as string | null) ?? defaultHost ?? null;
        const key = FULL_URL_DIMENSIONS.has(pageDim)
            ? toUrlKey(value as string | null)
            : toUrlKey(value as string | null, host);
        return { url_key: key, ...row };
    });
}

/** Percent change from previous to current, 1 decimal; null when previous is 0 or missing. */
export function pctChange(current: number | null | undefined, previous: number | null | undefined): number | null {
    if (current === null || current === undefined || previous === null || previous === undefined || previous === 0) {
        return null;
    }
    return round(((current - previous) / Math.abs(previous)) * 100, 1);
}

/** Safe ratio, rounded; null when the denominator is 0. */
export function ratio(numerator: number | null | undefined, denominator: number | null | undefined, decimals = 4): number | null {
    if (!denominator || numerator === null || numerator === undefined) return null;
    return round(numerator / denominator, decimals);
}

/** Shape rows for output: compact = {columns, rows: arrays}, full = {rows: objects}. */
export function shapeRows(rows: Row[], format: OutputFormat, columns?: string[]): { columns?: string[]; rows: Row[] | Cell[][] } {
    if (format === 'full') return { rows };
    // Union of all rows' keys, in first-seen order (rows can have different fields, e.g. found:false).
    const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { columns: cols, rows: rows.map((r) => cols.map((c) => (r[c] === undefined ? null : r[c]))) };
}

/** Format a number for a human-readable summary sentence. */
export function fmt(value: number | null | undefined, kind: 'int' | 'pct' | 'sec' | 'num' = 'num'): string {
    if (value === null || value === undefined) return 'n/a';
    if (kind === 'int') return Math.round(value).toLocaleString('en-US');
    if (kind === 'pct') return `${round(value * 100, 1)}%`;
    if (kind === 'sec') return `${round(value, 1)}s`;
    return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** "+12.3%" / "-4%" / "n/a" for a percent change. */
export function fmtChange(change: number | null): string {
    if (change === null) return 'n/a';
    return `${change > 0 ? '+' : ''}${change}%`;
}
