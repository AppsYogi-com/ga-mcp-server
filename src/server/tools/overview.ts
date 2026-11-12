/**
 * Opinionated overview tools: traffic KPIs, acquisition, key events.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { daysInRange } from '../../lib/dates.js';
import { inListExpression } from '../../lib/filters.js';
import { addUrlKeys, fmt, fmtChange, pctChange, ratio, type Row } from '../../lib/format.js';
import { uniqueWarnings } from '../../lib/warnings.js';
import type { ServerContext } from '../context.js';
import { runBatch, runReport, type ReportSpec } from '../report.js';
import {
    compareArg, dateArgs, defineTool, envelope, filtersArg, formatArg, limitArg, propertyArg, resolveRanges,
} from './shared.js';

const KPI_METRICS = [
    'sessions', 'totalUsers', 'newUsers', 'engagedSessions', 'engagementRate', 'screenPageViews', 'keyEvents',
    'userEngagementDuration', 'averageSessionDuration', 'bounceRate',
];

/**
 * Pivot rows of a two-range report (GA adds a "dateRange" dimension) into one row per key with
 * current, previous and change columns for each metric.
 */
export function pivotByRange(rows: Row[], keyDims: string[], metrics: string[]): Row[] {
    const byKey = new Map<string, { current?: Row; previous?: Row }>();
    for (const row of rows) {
        const key = keyDims.map((d) => row[d]).join('\u0000');
        const entry = byKey.get(key) ?? {};
        if (row.dateRange === 'previous') entry.previous = row;
        else entry.current = row;
        byKey.set(key, entry);
    }
    return [...byKey.values()].map(({ current, previous }) => {
        const base = current ?? previous!;
        const out: Row = {};
        for (const d of keyDims) out[d] = base[d];
        for (const m of metrics) {
            const cur = (current?.[m] as number | null | undefined) ?? 0;
            const prev = (previous?.[m] as number | null | undefined) ?? 0;
            out[m] = cur;
            out[`${m}_prev`] = prev;
            out[`${m}_change_pct`] = pctChange(cur, prev);
        }
        return out;
    });
}

const ACQUISITION_DIMENSIONS = {
    channel: ['sessionDefaultChannelGroup', 'firstUserDefaultChannelGroup'],
    source_medium: ['sessionSourceMedium', 'firstUserSourceMedium'],
    source: ['sessionSource', 'firstUserSource'],
    medium: ['sessionMedium', 'firstUserMedium'],
    campaign: ['sessionCampaignName', 'firstUserCampaignName'],
} as const;

export function registerOverviewTools(server: McpServer, ctx: ServerContext): void {
    defineTool(
        server,
        ctx,
        'ga_traffic_overview',
        {
            title: 'Traffic overview',
            description:
                'Headline KPIs for a site (sessions, users, new users, engagement rate, views, key events, engagement time, bounce rate) ' +
                'compared with the previous period or year, plus the channel breakdown (Organic Search, Direct, Referral...). ' +
                'One batched API call. Start here for "how is this site doing?".',
            inputSchema: {
                property: propertyArg,
                ...dateArgs,
                compare: compareArg.describe('Default previous_period.'),
                includeTrend: z.boolean().optional().describe('Add a sessions/users trend (daily up to 31 days, weekly up to 180, else monthly).'),
                format: formatArg,
            },
        },
        async (args) => {
            const property = await ctx.property(args.property);
            const compare = args.compare ?? 'previous_period';
            const { current, ranges } = resolveRanges(property.timeZone, args, compare);
            const specs: ReportSpec[] = [
                { metrics: KPI_METRICS, ranges },
                {
                    dimensions: ['sessionDefaultChannelGroup'],
                    metrics: ['sessions', 'totalUsers', 'engagedSessions', 'keyEvents'],
                    ranges,
                    orderBy: '-sessions',
                    limit: 50,
                },
            ];
            const days = daysInRange(current);
            const trendDim = days <= 31 ? 'date' : days <= 180 ? 'isoYearIsoWeek' : 'yearMonth';
            if (args.includeTrend) {
                specs.push({ dimensions: [trendDim], metrics: ['sessions', 'totalUsers', 'keyEvents'], ranges: [current], orderBy: trendDim, limit: 400 });
            }
            const [kpiReport, channelReport, trendReport] = await runBatch(ctx, property, specs);

            const comparing = ranges.length > 1;
            const kpiRows = kpiReport.parsed.rows;
            const kpiCurrent = (comparing ? kpiRows.find((r) => r.dateRange === 'current') : kpiRows[0]) ?? {};
            const kpiPrevious = comparing ? kpiRows.find((r) => r.dateRange === 'previous') ?? {} : undefined;
            const kpis: Row[] = KPI_METRICS.map((m) => ({
                metric: m,
                current: (kpiCurrent[m] as number | null) ?? 0,
                ...(kpiPrevious ? { previous: (kpiPrevious[m] as number | null) ?? 0, change_pct: pctChange(kpiCurrent[m] as number, kpiPrevious[m] as number) } : {}),
            }));
            kpis.push({
                metric: 'avgEngagementTimePerSession',
                current: ratio(kpiCurrent.userEngagementDuration as number, kpiCurrent.sessions as number, 1),
                ...(kpiPrevious
                    ? {
                          previous: ratio(kpiPrevious.userEngagementDuration as number, kpiPrevious.sessions as number, 1),
                          change_pct: pctChange(
                              ratio(kpiCurrent.userEngagementDuration as number, kpiCurrent.sessions as number, 1),
                              ratio(kpiPrevious.userEngagementDuration as number, kpiPrevious.sessions as number, 1),
                          ),
                      }
                    : {}),
            });

            const channelMetrics = ['sessions', 'totalUsers', 'engagedSessions', 'keyEvents'];
            const channels = (comparing
                ? pivotByRange(channelReport.parsed.rows, ['sessionDefaultChannelGroup'], channelMetrics)
                : channelReport.parsed.rows
            ).map((row): Row => ({
                ...row,
                share_pct: ratio((row.sessions as number) * 100, kpiCurrent.sessions as number, 1),
                engagement_rate: ratio(row.engagedSessions as number, row.sessions as number, 3),
            }));
            channels.sort((a, b) => ((b.sessions as number) ?? 0) - ((a.sessions as number) ?? 0));

            const kpi = (m: string) => kpis.find((k) => k.metric === m)!;
            const change = (m: string) => (kpiPrevious ? ` (${fmtChange(kpi(m).change_pct as number | null)})` : '');
            const top = channels[0];
            const summary =
                `Sessions ${fmt(kpi('sessions').current as number, 'int')}${change('sessions')}, users ${fmt(kpi('totalUsers').current as number, 'int')}${change('totalUsers')}, ` +
                `engagement rate ${fmt(kpi('engagementRate').current as number, 'pct')}, key events ${fmt(kpi('keyEvents').current as number, 'int')}${change('keyEvents')}` +
                `${kpiPrevious ? ` vs ${compare === 'previous_year' ? 'last year' : 'the previous period'}` : ''}.` +
                `${top ? ` Top channel: ${top.sessionDefaultChannelGroup} (${top.share_pct}% of sessions).` : ''}`;

            return envelope({
                property,
                ranges,
                summary,
                rows: channels,
                format: args.format,
                warnings: uniqueWarnings(kpiReport.warnings, channelReport.warnings, trendReport?.warnings ?? []),
                quota: (trendReport ?? channelReport).quota,
                extra: {
                    kpis,
                    ...(trendReport ? { trend: { dimension: trendDim, rows: trendReport.parsed.rows } } : {}),
                    rows_are: 'channels',
                },
            });
        },
    );

    defineTool(
        server,
        ctx,
        'ga_acquisition',
        {
            title: 'Traffic acquisition',
            description:
                'Where visitors come from: by default channel group, source/medium, source, medium or campaign, with sessions, users, ' +
                'new users, engagement and key events. firstUser=true attributes users to the channel that first brought them (user acquisition).',
            inputSchema: {
                property: propertyArg,
                by: z.enum(['channel', 'source_medium', 'source', 'medium', 'campaign']).optional().describe('Default channel.'),
                firstUser: z.boolean().optional().describe('Use first-user (user acquisition) dimensions instead of session ones.'),
                ...dateArgs,
                compare: compareArg.describe('Default none.'),
                filters: filtersArg,
                limit: limitArg(25, 1000),
                format: formatArg,
            },
        },
        async (args) => {
            const property = await ctx.property(args.property);
            const dimension = ACQUISITION_DIMENSIONS[args.by ?? 'channel'][args.firstUser ? 1 : 0];
            const { ranges } = resolveRanges(property.timeZone, args, args.compare ?? 'none');
            const metrics = ['sessions', 'totalUsers', 'newUsers', 'engagedSessions', 'userEngagementDuration', 'keyEvents'];
            const limit = args.limit ?? 25;
            const result = await runReport(ctx, property, {
                dimensions: [dimension],
                metrics,
                ranges,
                filters: args.filters,
                orderBy: args.firstUser ? '-newUsers' : '-sessions',
                limit: ranges.length > 1 ? limit * 2 : limit,
            });
            const comparing = ranges.length > 1;
            const base = comparing ? pivotByRange(result.parsed.rows, [dimension], metrics) : result.parsed.rows;
            const rows = base
                .map((r): Row => ({
                    ...r,
                    engagement_rate: ratio(r.engagedSessions as number, r.sessions as number, 3),
                    avg_engagement_sec: ratio(r.userEngagementDuration as number, r.sessions as number, 1),
                }))
                .sort((a, b) => ((b[args.firstUser ? 'newUsers' : 'sessions'] as number) ?? 0) - ((a[args.firstUser ? 'newUsers' : 'sessions'] as number) ?? 0))
                .slice(0, limit);
            const totalSessions = (result.parsed.totals.current ?? result.parsed.totals.total)?.sessions as number | undefined;
            const top = rows[0];
            return envelope({
                property,
                ranges,
                summary: top
                    ? `Top ${dimension}: "${top[dimension]}" with ${fmt(top.sessions as number, 'int')} sessions` +
                      `${totalSessions ? ` (${ratio((top.sessions as number) * 100, totalSessions, 1)}% of ${fmt(totalSessions, 'int')})` : ''}.`
                    : 'No traffic in this date range.',
                totals: result.parsed.totals,
                rows,
                format: args.format,
                rowCount: comparing ? rows.length : result.parsed.rowCount,
                warnings: result.warnings,
                quota: result.quota,
                extra: { dimension },
            });
        },
    );

    defineTool(
        server,
        ctx,
        'ga_key_events',
        {
            title: 'Key events (conversions)',
            description:
                'The property\'s key events (formerly conversions) and how often each happened, optionally broken down by channel, ' +
                'landing page or page (page rows get url_key). Tells you which traffic and pages actually convert.',
            inputSchema: {
                property: propertyArg,
                by: z.enum(['none', 'channel', 'landingPage', 'pagePath']).optional().describe('Breakdown. Default none.'),
                ...dateArgs,
                compare: compareArg.describe('Default none.'),
                filters: filtersArg,
                limit: limitArg(25, 1000),
                format: formatArg,
            },
        },
        async (args) => {
            const property = await ctx.property(args.property);
            const client = await ctx.client();
            const keyEvents = (await ctx.cache.getOrSet(`keyEvents:${property.id}`, 60 * 60 * 1000, () => client.listKeyEvents(property.id))).map((k) => k.eventName);
            const { ranges } = resolveRanges(property.timeZone, args, args.compare ?? 'none');
            if (keyEvents.length === 0) {
                return envelope({
                    property,
                    ranges,
                    summary: 'This property has no key events configured. Mark events as key events in GA4 (Admin → Events) to track conversions.',
                    rows: [],
                    format: args.format,
                    extra: { key_events: [] },
                });
            }
            const by = args.by ?? 'none';
            const breakdown = by === 'channel' ? ['sessionDefaultChannelGroup'] : by === 'none' ? [] : ['hostName', by];
            const dimensions = ['eventName', ...breakdown];
            const metrics = ['keyEvents', 'totalUsers'];
            const limit = args.limit ?? 25;
            const result = await runReport(ctx, property, {
                dimensions,
                metrics,
                ranges,
                filters: args.filters,
                dimensionFilter: inListExpression('eventName', keyEvents),
                orderBy: '-keyEvents',
                limit: ranges.length > 1 ? limit * 2 : limit,
            });
            const comparing = ranges.length > 1;
            let rows = comparing ? pivotByRange(result.parsed.rows, dimensions, metrics) : result.parsed.rows;
            rows = addUrlKeys(rows, dimensions, property.hosts[0])
                .sort((a, b) => ((b.keyEvents as number) ?? 0) - ((a.keyEvents as number) ?? 0))
                .slice(0, limit);
            const total = (result.parsed.totals.current ?? result.parsed.totals.total)?.keyEvents as number | undefined;
            return envelope({
                property,
                ranges,
                summary: `${fmt(total ?? 0, 'int')} key events across ${keyEvents.length} configured (${keyEvents.join(', ')})` +
                    `${rows[0] ? `; top: ${rows[0].eventName}${breakdown.length ? ` from ${rows[0][breakdown[breakdown.length - 1]]}` : ''} (${fmt(rows[0].keyEvents as number, 'int')})` : ''}.`,
                totals: result.parsed.totals,
                rows,
                format: args.format,
                rowCount: comparing ? rows.length : result.parsed.rowCount,
                warnings: result.warnings,
                quota: result.quota,
                extra: { key_events: keyEvents },
            });
        },
    );
}
