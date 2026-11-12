/**
 * Build and run GA4 report requests: friendly filters, ordering, totals, quota, warnings, cache.
 */

import { TTL } from '../ga/cache.js';
import { UserInputError } from '../ga/errors.js';
import type { DateRange } from '../lib/dates.js';
import { staticFieldKind, type FieldKind } from '../lib/fields.js';
import { andExpressions, compileFilters, type FilterExpression } from '../lib/filters.js';
import { parseReport, type GaReportResponse, type ParsedReport } from '../lib/format.js';
import { parseQuota, quotaWarnings, type QuotaSummary } from '../lib/quota.js';
import { metadataWarnings, todayWarning, uniqueWarnings } from '../lib/warnings.js';
import { filterFieldNames, type ServerContext } from './context.js';

export interface ReportSpec {
    dimensions?: string[];
    metrics: string[];
    ranges: DateRange[];
    filters?: string[];
    dimensionFilter?: FilterExpression;
    metricFilter?: FilterExpression;
    /** "-sessions" (descending) or "pagePath" (ascending); dimension or metric names. */
    orderBy?: string | string[];
    limit?: number;
    offset?: number;
    keepEmptyRows?: boolean;
}

export interface ReportResult {
    parsed: ParsedReport;
    response: GaReportResponse;
    warnings: string[];
    quota: QuotaSummary | null;
}

export const MAX_DIMENSIONS = 9;
export const MAX_METRICS = 10;

export function buildOrderBys(orderBy: string | string[] | undefined, kindOf: (name: string) => FieldKind | undefined, dimensions: string[], metrics: string[]) {
    const entries = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).filter(Boolean);
    return entries.map((entry) => {
        const desc = entry.startsWith('-');
        const name = entry.replace(/^[-+]/, '');
        const kind = metrics.includes(name) ? 'metric' : dimensions.includes(name) ? 'dimension' : kindOf(name);
        if (kind === 'metric') return { metric: { metricName: name }, desc };
        if (kind === 'dimension') return { dimension: { dimensionName: name }, desc };
        throw new UserInputError(`orderBy "${entry}": "${name}" isn't a known field. Order by a dimension or metric in the report.`);
    });
}

/** Build a runReport request body. */
export async function buildRequest(ctx: ServerContext, propertyId: string, spec: ReportSpec): Promise<Record<string, unknown>> {
    const dimensions = spec.dimensions ?? [];
    if (dimensions.length > MAX_DIMENSIONS) throw new UserInputError(`GA4 allows at most ${MAX_DIMENSIONS} dimensions per report.`);
    if (spec.metrics.length === 0) throw new UserInputError('At least one metric is required.');
    if (spec.metrics.length > MAX_METRICS) throw new UserInputError(`GA4 allows at most ${MAX_METRICS} metrics per report.`);

    const orderNames = (Array.isArray(spec.orderBy) ? spec.orderBy : spec.orderBy ? [spec.orderBy] : []).map((o) => o.replace(/^[-+]/, ''));
    const kindOf = await ctx.kindResolver(propertyId, [...filterFieldNames(spec.filters), ...orderNames]);
    const compiled = compileFilters(spec.filters, kindOf);

    const request: Record<string, unknown> = {
        dateRanges: spec.ranges.map((r) => ({ startDate: r.startDate, endDate: r.endDate, ...(r.name ? { name: r.name } : {}) })),
        dimensions: dimensions.map((name) => ({ name })),
        metrics: spec.metrics.map((name) => ({ name })),
        metricAggregations: ['TOTAL'],
        returnPropertyQuota: true,
    };
    const dimensionFilter = andExpressions(spec.dimensionFilter, compiled.dimensionFilter);
    const metricFilter = andExpressions(spec.metricFilter, compiled.metricFilter);
    if (dimensionFilter) request.dimensionFilter = dimensionFilter;
    if (metricFilter) request.metricFilter = metricFilter;
    const orders = buildOrderBys(spec.orderBy, (n) => kindOf(n) ?? staticFieldKind(n), dimensions, spec.metrics);
    if (orders.length) request.orderBys = orders;
    if (spec.limit !== undefined) request.limit = spec.limit;
    if (spec.offset) request.offset = spec.offset;
    if (spec.keepEmptyRows) request.keepEmptyRows = true;
    return request;
}

/** Collect warnings and quota from a response. */
export function responseExtras(response: GaReportResponse, ranges: DateRange[], timeZone: string): { warnings: string[]; quota: QuotaSummary | null } {
    return {
        warnings: uniqueWarnings(metadataWarnings(response.metadata), todayWarning(ranges, timeZone), quotaWarnings(response.propertyQuota)),
        quota: parseQuota(response.propertyQuota),
    };
}

/** Run one report (cached for 5 minutes). */
export async function runReport(ctx: ServerContext, property: { id: string; timeZone: string }, spec: ReportSpec): Promise<ReportResult> {
    const request = await buildRequest(ctx, property.id, spec);
    const client = await ctx.client();
    const response = await ctx.cache.getOrSet(`report:${property.id}:${JSON.stringify(request)}`, TTL.report, () =>
        client.runReport(property.id, request),
    );
    return { parsed: parseReport(response), response, ...responseExtras(response, spec.ranges, property.timeZone) };
}

/** Run up to 5 reports in one batchRunReports call (cached for 5 minutes). */
export async function runBatch(ctx: ServerContext, property: { id: string; timeZone: string }, specs: ReportSpec[]): Promise<ReportResult[]> {
    if (specs.length > 5) throw new Error('batchRunReports accepts at most 5 reports');
    const requests = await Promise.all(specs.map((s) => buildRequest(ctx, property.id, s)));
    const client = await ctx.client();
    const responses = await ctx.cache.getOrSet(`batch:${property.id}:${JSON.stringify(requests)}`, TTL.report, () =>
        client.batchRunReports(property.id, requests),
    );
    return responses.map((response, i) => ({ parsed: parseReport(response), response, ...responseExtras(response, specs[i].ranges, property.timeZone) }));
}
