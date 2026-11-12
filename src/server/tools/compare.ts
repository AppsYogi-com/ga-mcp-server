/**
 * Period comparisons and opportunity finders.
 *
 * Comparisons use "anchor then lookup": take the top N rows in the anchor period, then query the
 * other period for exactly those values. That gives exact changes instead of comparing two
 * independent top-N lists (where a row can be missing from one side).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UserInputError } from '../../ga/errors.js';
import { comparisonRange, resolveDateRange, type DateRange } from '../../lib/dates.js';
import { andExpressions, inListExpression, type FilterExpression } from '../../lib/filters.js';
import { addUrlKeys, fmt, fmtChange, pctChange, ratio, type Row } from '../../lib/format.js';
import { mergeRows } from '../../lib/merge.js';
import { uniqueWarnings } from '../../lib/warnings.js';
import type { ServerContext } from '../context.js';
import { MAX_DIMENSIONS, runBatch, runReport } from '../report.js';
import { dateArgs, defineTool, derivePageRatios, envelope, filtersArg, formatArg, limitArg, propertyArg } from './shared.js';

const ORGANIC = 'sessionDefaultChannelGroup==Organic Search';

const periodSchema = z.object({ startDate: z.string(), endDate: z.string() });

function keyOf(row: Row, dims: string[]): string {
    return dims.map((d) => String(row[d])).join('\u0000');
}

export function registerCompareTools(server: McpServer, ctx: ServerContext): void {
    defineTool(
        server,
        ctx,
        'ga_compare_periods',
        {
            title: 'Compare two periods',
            description:
                'Compare any breakdown between two periods: the top rows of the current period with their exact previous values, ' +
                'change and % change for each metric, plus true totals for both periods (from GA, not summed from the shown rows). ' +
                'Without dimensions it compares site totals. Page dimensions get url_key.',
            inputSchema: {
                property: propertyArg,
                dimensions: z.array(z.string()).max(MAX_DIMENSIONS - 1).optional().describe('Breakdown dimensions (optional).'),
                metrics: z.array(z.string()).min(1).max(10).describe('Metrics to compare.'),
                ...dateArgs,
                compare: z.enum(['previous_period', 'previous_year']).optional().describe('Comparison period (default previous_period). Ignored when periodB is given.'),
                periodB: periodSchema.optional().describe('Explicit comparison period {startDate, endDate}.'),
                filters: filtersArg,
                orderBy: z.string().optional().describe('Metric that picks the top rows, descending (default: first metric).'),
                limit: limitArg(25, 1000),
                format: formatArg,
            },
        },
        async (args) => {
            const property = await ctx.property(args.property);
            const current: DateRange = resolveDateRange(args, property.timeZone);
            const previous: DateRange = args.periodB
                ? resolveDateRange({ startDate: args.periodB.startDate, endDate: args.periodB.endDate }, property.timeZone)
                : comparisonRange(current, args.compare ?? 'previous_period')!;
            const dims = args.dimensions ?? [];
            const sortMetric = (args.orderBy ?? args.metrics[0]).replace(/^-/, '');
            if (!args.metrics.includes(sortMetric)) throw new UserInputError(`orderBy "${sortMetric}" must be one of the metrics.`);
            const limit = args.limit ?? 25;

            // 1 call: current top rows (with totals) + previous totals.
            const [anchor, previousTotals] = await runBatch(ctx, property, [
                { dimensions: dims, metrics: args.metrics, ranges: [current], filters: args.filters, orderBy: `-${sortMetric}`, limit },
                { metrics: args.metrics, ranges: [previous], filters: args.filters },
            ]);
            const totalsCurrent = anchor.parsed.totals.total ?? anchor.parsed.rows[0] ?? {};
            const totalsPrevious = previousTotals.parsed.totals.total ?? previousTotals.parsed.rows[0] ?? {};
            const totals = Object.fromEntries(
                args.metrics.map((m) => [m, { current: totalsCurrent[m] ?? 0, previous: totalsPrevious[m] ?? 0, change_pct: pctChange(totalsCurrent[m] as number, totalsPrevious[m] as number) }]),
            );

            let rows: Row[] = [];
            let warnings = uniqueWarnings(anchor.warnings, previousTotals.warnings);
            if (dims.length > 0 && anchor.parsed.rows.length > 0) {
                // 2nd call: the previous period for exactly the anchor's dimension values.
                const lookupFilter: FilterExpression | undefined = andExpressions(
                    ...dims.map((d) => inListExpression(d, [...new Set(anchor.parsed.rows.map((r) => String(r[d])))])),
                );
                const lookup = await runReport(ctx, property, {
                    dimensions: dims, metrics: args.metrics, ranges: [previous], filters: args.filters, dimensionFilter: lookupFilter, limit: 10000,
                });
                warnings = uniqueWarnings(warnings, lookup.warnings);
                const prevByKey = new Map(lookup.parsed.rows.map((r) => [keyOf(r, dims), r]));
                rows = anchor.parsed.rows.map((row) => {
                    const prev = prevByKey.get(keyOf(row, dims));
                    const out: Row = {};
                    for (const d of dims) out[d] = row[d];
                    for (const m of args.metrics) {
                        const cur = (row[m] as number | null) ?? 0;
                        const before = (prev?.[m] as number | null | undefined) ?? 0;
                        out[m] = cur;
                        out[`${m}_prev`] = before;
                        out[`${m}_change`] = Math.round((cur - before) * 1000) / 1000;
                        out[`${m}_change_pct`] = pctChange(cur, before);
                    }
                    return out;
                });
                rows = addUrlKeys(rows, dims, property.hosts[0]);
            }

            const first = args.metrics[0];
            const t = totals[first] as { current: number; previous: number; change_pct: number | null };
            const movers = [...rows].sort((a, b) => Math.abs((b[`${first}_change`] as number) ?? 0) - Math.abs((a[`${first}_change`] as number) ?? 0));
            const mover = movers[0];
            return envelope({
                property,
                ranges: [{ ...current, name: 'current' }, { ...previous, name: 'previous' }],
                summary:
                    `${first}: ${fmt(t.current)} vs ${fmt(t.previous)} (${fmtChange(t.change_pct)}).` +
                    (mover && dims.length ? ` Biggest change: ${dims.map((d) => mover[d]).join(' / ')} (${fmtChange(mover[`${first}_change_pct`] as number | null)}).` : ''),
                totals,
                rows,
                format: args.format,
                rowCount: rows.length,
                warnings,
                quota: anchor.quota,
            });
        },
    );

    defineTool(
        server,
        ctx,
        'ga_declining_pages',
        {
            title: 'Declining pages',
            description:
                'Pages that lost the most traffic: takes the pages with enough traffic in the previous period, looks up the same pages now, ' +
                'and ranks them by absolute loss. mode=landing (default) uses sessions starting on the page; organicOnly isolates SEO losses ' +
                '(check Search Console for those url_keys next). mode=page uses page views.',
            inputSchema: {
                property: propertyArg,
                mode: z.enum(['landing', 'page']).optional().describe('landing (sessions, default) or page (views).'),
                organicOnly: z.boolean().optional().describe('Only Organic Search sessions.'),
                minPrevious: z.number().int().min(1).optional().describe('Minimum sessions/views in the previous period (default 50).'),
                ...dateArgs,
                compare: z.enum(['previous_period', 'previous_year']).optional().describe('Default previous_period.'),
                filters: filtersArg,
                limit: limitArg(25, 500),
                format: formatArg,
            },
        },
        async (args) => {
            const property = await ctx.property(args.property);
            const current = resolveDateRange(args, property.timeZone);
            const previous = comparisonRange(current, args.compare ?? 'previous_period')!;
            const landing = (args.mode ?? 'landing') === 'landing';
            const pathDim = landing ? 'landingPage' : 'pagePath';
            const metric = landing ? 'sessions' : 'screenPageViews';
            const metrics = [metric, 'keyEvents'];
            const min = args.minPrevious ?? 50;
            const filters = [...(args.filters ?? []), ...(args.organicOnly ? [ORGANIC] : [])];

            // Anchor: previous period, pages above the threshold.
            const anchor = await runReport(ctx, property, {
                dimensions: ['hostName', pathDim], metrics, ranges: [previous], filters: [...filters, `${metric}>=${min}`], orderBy: `-${metric}`, limit: 1000,
            });
            if (anchor.parsed.rows.length === 0) {
                return envelope({ property, ranges: [{ ...current, name: 'current' }, { ...previous, name: 'previous' }], summary: `No pages had ${min}+ ${metric} in the previous period.`, rows: [], format: args.format, warnings: anchor.warnings, quota: anchor.quota });
            }
            // Lookup: the same host/path values in the current period.
            const hosts = [...new Set(anchor.parsed.rows.map((r) => String(r.hostName)))];
            const paths = [...new Set(anchor.parsed.rows.map((r) => String(r[pathDim])))];
            const lookup = await runReport(ctx, property, {
                dimensions: ['hostName', pathDim], metrics, ranges: [current], filters,
                dimensionFilter: andExpressions(inListExpression('hostName', hosts), inListExpression(pathDim, paths)), limit: 10000,
            });

            const prev = mergeRows(addUrlKeys(anchor.parsed.rows, ['hostName', pathDim], property.hosts[0]), (r) => r.url_key as string | null, metrics, ['url_key', pathDim]).rows;
            const now = new Map(
                mergeRows(addUrlKeys(lookup.parsed.rows, ['hostName', pathDim], property.hosts[0]), (r) => r.url_key as string | null, metrics, ['url_key'])
                    .rows.map((r) => [r.url_key as string, r]),
            );
            const rows = prev
                .map((p) => {
                    const c = now.get(p.url_key as string);
                    const before = (p[metric] as number) ?? 0;
                    const after = (c?.[metric] as number) ?? 0;
                    return {
                        url_key: p.url_key,
                        [pathDim]: p[pathDim],
                        [`${metric}_prev`]: before,
                        [metric]: after,
                        change: after - before,
                        change_pct: pctChange(after, before),
                        key_events_prev: (p.keyEvents as number) ?? 0,
                        key_events: (c?.keyEvents as number) ?? 0,
                    } as Row;
                })
                .filter((r) => (r.change as number) < 0)
                .sort((a, b) => (a.change as number) - (b.change as number));
            const totalLoss = rows.reduce((sum, r) => sum + (r.change as number), 0);
            const worst = rows[0];
            return envelope({
                property,
                ranges: [{ ...current, name: 'current' }, { ...previous, name: 'previous' }],
                summary: worst
                    ? `${rows.length} of ${prev.length} pages lost ${metric}${args.organicOnly ? ' from organic search' : ''} (total ${fmt(totalLoss, 'int')}); ` +
                      `biggest: ${worst.url_key} ${fmt(worst[`${metric}_prev`] as number, 'int')} → ${fmt(worst[metric] as number, 'int')} (${fmtChange(worst.change_pct as number | null)}).`
                    : `None of the ${prev.length} pages with ${min}+ ${metric} lost traffic.`,
                rows: rows.slice(0, args.limit ?? 25),
                format: args.format,
                rowCount: rows.length,
                warnings: uniqueWarnings(anchor.warnings, lookup.warnings),
                quota: lookup.quota,
                extra: { metric, total_change: totalLoss },
            });
        },
    );

    defineTool(
        server,
        ctx,
        'ga_engagement_gaps',
        {
            title: 'Engagement gaps',
            description:
                'High-traffic pages that underperform: engagement rate below a threshold and/or no key events despite many sessions. ' +
                'Each row has a reason. Good candidates for content, UX or call-to-action improvements; combine with Search Console ' +
                'queries for the same url_key to check search intent.',
            inputSchema: {
                property: propertyArg,
                mode: z.enum(['landing', 'page']).optional().describe('landing (default): sessions starting on the page. page: any session viewing it.'),
                organicOnly: z.boolean().optional().describe('Only Organic Search sessions.'),
                minSessions: z.number().int().min(1).optional().describe('Minimum sessions (default 100).'),
                maxEngagementRate: z.number().min(0).max(1).optional().describe('Flag pages below this engagement rate (default 0.4).'),
                flagNoKeyEvents: z.boolean().optional().describe('Also flag pages with zero key events (default true; skipped if the property has no key events).'),
                ...dateArgs,
                filters: filtersArg,
                limit: limitArg(25, 500),
                format: formatArg,
            },
        },
        async (args) => {
            const property = await ctx.property(args.property);
            const range = resolveDateRange(args, property.timeZone);
            const pathDim = (args.mode ?? 'landing') === 'landing' ? 'landingPage' : 'pagePath';
            const metrics = ['sessions', 'engagedSessions', 'keyEvents', 'userEngagementDuration'];
            const minSessions = args.minSessions ?? 100;
            const maxRate = args.maxEngagementRate ?? 0.4;
            const client = await ctx.client();
            const keyEvents = await ctx.cache.getOrSet(`keyEvents:${property.id}`, 60 * 60 * 1000, () => client.listKeyEvents(property.id)).catch(() => []);
            const flagNoKeyEvents = (args.flagNoKeyEvents ?? true) && keyEvents.length > 0;

            const result = await runReport(ctx, property, {
                dimensions: ['hostName', pathDim],
                metrics,
                ranges: [range],
                filters: [...(args.filters ?? []), ...(args.organicOnly ? [ORGANIC] : []), `sessions>=${minSessions}`],
                orderBy: '-sessions',
                limit: 2000,
            });
            const merged = mergeRows(addUrlKeys(result.parsed.rows, ['hostName', pathDim], property.hosts[0]), (r) => r.url_key as string | null, metrics, ['url_key', pathDim]);
            const rows = merged.rows
                .map(derivePageRatios)
                .map((r): Row => {
                    const reasons: string[] = [];
                    const rate = r.engagement_rate as number | null;
                    if (rate !== null && rate < maxRate) reasons.push(`low engagement: ${fmt(rate, 'pct')} (< ${fmt(maxRate, 'pct')})`);
                    if (flagNoKeyEvents && !(r.keyEvents as number)) reasons.push(`no key events from ${fmt(r.sessions as number, 'int')} sessions`);
                    return { ...r, reason: reasons.join('; ') };
                })
                .filter((r) => r.reason)
                .sort((a, b) => ((b.sessions as number) ?? 0) - ((a.sessions as number) ?? 0));
            const sessionsAffected = rows.reduce((sum, r) => sum + ((r.sessions as number) ?? 0), 0);
            return envelope({
                property,
                ranges: [range],
                summary: rows.length
                    ? `${rows.length} of ${merged.rows.length} pages with ${minSessions}+ sessions underperform (${fmt(sessionsAffected, 'int')} sessions); ` +
                      `biggest: ${rows[0].url_key} (${rows[0].reason}).`
                    : `No underperforming pages among the ${merged.rows.length} with ${minSessions}+ sessions.`,
                rows: rows.slice(0, args.limit ?? 25),
                format: args.format,
                rowCount: rows.length,
                warnings: [
                    ...result.warnings,
                    ...((args.flagNoKeyEvents ?? true) && keyEvents.length === 0 ? ['No key events are configured, so only engagement was checked.'] : []),
                ],
                quota: result.quota,
                extra: { thresholds: { min_sessions: minSessions, max_engagement_rate: maxRate }, engagement_rate_avg: ratio(
                    merged.rows.reduce((s, r) => s + ((r.engagedSessions as number) ?? 0), 0),
                    merged.rows.reduce((s, r) => s + ((r.sessions as number) ?? 0), 0),
                    3,
                ) },
            });
        },
    );
}
