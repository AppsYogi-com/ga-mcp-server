/**
 * Generic tools: any GA4 report, and the realtime report.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UserInputError } from '../../ga/errors.js';
import { FULL_URL_DIMENSIONS, PAGE_DIMENSIONS, staticFieldKind } from '../../lib/fields.js';
import { andExpressions, compileFilters, type FilterExpression } from '../../lib/filters.js';
import { addUrlKeys, fmt, parseReport, type Row } from '../../lib/format.js';
import { parseQuota, quotaWarnings } from '../../lib/quota.js';
import { metadataWarnings, uniqueWarnings } from '../../lib/warnings.js';
import { filterFieldNames, type ServerContext } from '../context.js';
import { buildOrderBys, MAX_DIMENSIONS, runReport } from '../report.js';
import {
    compareArg, dateArgs, defineTool, envelope, filtersArg, formatArg, limitArg, offsetArg, propertyArg, resolveRanges,
} from './shared.js';

const GRANULARITY_DIMENSION = { day: 'date', week: 'isoYearIsoWeek', month: 'yearMonth' } as const;

const rawFilterArg = z
    .record(z.string(), z.any())
    .optional()
    .describe('Raw GA4 FilterExpression (andGroup/orGroup/notExpression/filter), ANDed with `filters`. For cases the friendly syntax can\'t express.');

function firstMetricSummary(totals: Record<string, Row>, metrics: string[]): string {
    const first = metrics[0];
    const parts = Object.entries(totals).map(([name, row]) => `${name === 'total' ? '' : `${name}: `}${first} ${fmt(row[first] as number | null)}`);
    return parts.join(', ');
}

export function registerReportTools(server: McpServer, ctx: ServerContext): void {
    defineTool(
        server,
        ctx,
        'ga_run_report',
        {
            title: 'Run a GA4 report',
            description:
                'Any GA4 Data API report: up to 9 dimensions and 10 metrics, friendly filters, ordering, comparison periods and pagination. ' +
                'Rows with page dimensions (pagePath, landingPage, fullPageUrl...) get a url_key for joining with Search Console/AdSense/Ahrefs; ' +
                'hostName is added automatically for that. Totals cover all rows, not just the returned page. ' +
                'Common fields: dimensions date, pagePath, landingPage, hostName, sessionDefaultChannelGroup, sessionSourceMedium, country, deviceCategory, eventName; ' +
                'metrics sessions, totalUsers, newUsers, engagedSessions, engagementRate, screenPageViews, keyEvents, userEngagementDuration, totalRevenue, totalAdRevenue. ' +
                'Use ga_search_fields for others (including custom fields like customEvent:x).',
            inputSchema: {
                property: propertyArg,
                dimensions: z.array(z.string()).max(MAX_DIMENSIONS).optional().describe('Dimension API names (max 9). Empty = totals only.'),
                metrics: z.array(z.string()).min(1).max(10).describe('Metric API names (1-10).'),
                ...dateArgs,
                compare: compareArg,
                granularity: z.enum(['day', 'week', 'month']).optional().describe('Add a time dimension: day (date), week (isoYearIsoWeek) or month (yearMonth).'),
                filters: filtersArg,
                dimensionFilter: rawFilterArg,
                metricFilter: rawFilterArg,
                orderBy: z
                    .union([z.string(), z.array(z.string())])
                    .optional()
                    .describe('Field(s) to sort by; prefix with - for descending, e.g. "-sessions" or ["date", "-sessions"]. Default: first metric descending.'),
                keepEmptyRows: z.boolean().optional().describe('Include rows where every metric is 0.'),
                addHostName: z.boolean().optional().describe('Add hostName when page dimensions are used, for url_key (default true).'),
                limit: limitArg(100),
                offset: offsetArg,
                format: formatArg,
            },
        },
        async (args) => {
            const property = await ctx.property(args.property);
            const dimensions = [...(args.dimensions ?? [])];
            if (args.granularity) {
                const timeDim = GRANULARITY_DIMENSION[args.granularity];
                if (!dimensions.includes(timeDim)) dimensions.unshift(timeDim);
            }
            const pageDim = dimensions.find((d) => PAGE_DIMENSIONS.has(d));
            if (pageDim && !FULL_URL_DIMENSIONS.has(pageDim) && !dimensions.includes('hostName') && args.addHostName !== false) {
                if (dimensions.length < MAX_DIMENSIONS) dimensions.push('hostName');
            }
            if (dimensions.length > MAX_DIMENSIONS) throw new UserInputError(`At most ${MAX_DIMENSIONS} dimensions (including the granularity dimension).`);

            const { ranges } = resolveRanges(property.timeZone, args, args.compare);
            const limit = args.limit ?? 100;
            const orderBy = args.orderBy ?? (args.granularity ? GRANULARITY_DIMENSION[args.granularity] : `-${args.metrics[0]}`);
            const result = await runReport(ctx, property, {
                dimensions,
                metrics: args.metrics,
                ranges,
                filters: args.filters,
                dimensionFilter: args.dimensionFilter as FilterExpression | undefined,
                metricFilter: args.metricFilter as FilterExpression | undefined,
                orderBy,
                limit,
                offset: args.offset,
                keepEmptyRows: args.keepEmptyRows,
            });
            const rows = addUrlKeys(result.parsed.rows, result.parsed.dimensions, property.hosts[0]);
            return envelope({
                property,
                ranges,
                summary: `${result.parsed.rowCount} row${result.parsed.rowCount === 1 ? '' : 's'}` +
                    `${dimensions.length ? ` by ${dimensions.join(' × ')}` : ''}; ${firstMetricSummary(result.parsed.totals, args.metrics)}.`,
                totals: result.parsed.totals,
                rows,
                format: args.format,
                rowCount: result.parsed.rowCount,
                offset: args.offset,
                limit,
                warnings: result.warnings,
                quota: result.quota,
            });
        },
    );

    defineTool(
        server,
        ctx,
        'ga_run_realtime_report',
        {
            title: 'GA4 realtime report',
            description:
                'Activity in the last 30 minutes (up to 60 on GA4 360). Realtime dimensions include unifiedScreenName (page title/screen), ' +
                'country, city, deviceCategory, platform, eventName, minutesAgo and audienceName; metrics include activeUsers, eventCount, ' +
                'screenPageViews and keyEvents. Note: realtime has no pagePath, so rows have no url_key.',
            inputSchema: {
                property: propertyArg,
                dimensions: z.array(z.string()).max(MAX_DIMENSIONS).optional().describe('Default ["unifiedScreenName"]. Use [] for totals only.'),
                metrics: z.array(z.string()).min(1).max(10).optional().describe('Default ["activeUsers"].'),
                minutesAgoStart: z.number().int().min(0).max(59).optional().describe('Start of the window in minutes ago (default 29).'),
                minutesAgoEnd: z.number().int().min(0).max(59).optional().describe('End of the window in minutes ago (default 0 = now).'),
                filters: filtersArg,
                orderBy: z.union([z.string(), z.array(z.string())]).optional().describe('Default: first metric descending.'),
                limit: limitArg(25),
                format: formatArg,
            },
        },
        async (args) => {
            const property = await ctx.property(args.property);
            const dimensions = args.dimensions ?? ['unifiedScreenName'];
            const metrics = args.metrics ?? ['activeUsers'];
            const start = args.minutesAgoStart ?? 29;
            const end = args.minutesAgoEnd ?? 0;
            if (start < end) throw new UserInputError('minutesAgoStart must be greater than or equal to minutesAgoEnd.');

            const kindOf = await ctx.kindResolver(property.id, filterFieldNames(args.filters));
            const compiled = compileFilters(args.filters, kindOf);
            const request: Record<string, unknown> = {
                dimensions: dimensions.map((name) => ({ name })),
                metrics: metrics.map((name) => ({ name })),
                minuteRanges: [{ startMinutesAgo: start, endMinutesAgo: end }],
                metricAggregations: ['TOTAL'],
                returnPropertyQuota: true,
                limit: args.limit ?? 25,
            };
            const dimensionFilter = andExpressions(compiled.dimensionFilter);
            const metricFilter = andExpressions(compiled.metricFilter);
            if (dimensionFilter) request.dimensionFilter = dimensionFilter;
            if (metricFilter) request.metricFilter = metricFilter;
            const orders = buildOrderBys(args.orderBy ?? `-${metrics[0]}`, (n) => kindOf(n) ?? staticFieldKind(n), dimensions, metrics);
            if (orders.length) request.orderBys = orders;

            const client = await ctx.client();
            const response = await client.runRealtimeReport(property.id, request);
            const parsed = parseReport(response);
            const total = parsed.totals.total?.[metrics[0]] as number | undefined;
            const top = parsed.rows[0];
            return envelope({
                property,
                ranges: [],
                summary: `${fmt(total ?? null, 'int')} ${metrics[0]} in the last ${start + 1} minutes` +
                    `${top && dimensions.length ? `; top ${dimensions[0]}: "${top[dimensions[0]]}" (${fmt(top[metrics[0]] as number, 'int')})` : ''}.`,
                totals: parsed.totals,
                rows: parsed.rows,
                format: args.format,
                rowCount: parsed.rowCount,
                warnings: uniqueWarnings(metadataWarnings(response.metadata), quotaWarnings(response.propertyQuota)),
                quota: parseQuota(response.propertyQuota),
                extra: { window_minutes: { start_minutes_ago: start, end_minutes_ago: end } },
            });
        },
    );
}
