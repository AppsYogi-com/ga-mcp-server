/**
 * Page-level tools. Every row has a url_key; rows that normalize to the same url_key
 * ("/blog" and "/blog/") are merged, with ratios recomputed from the summed metrics.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UserInputError } from '../../ga/errors.js';
import { andExpressions, inListExpression } from '../../lib/filters.js';
import { addUrlKeys, fmt, type Row } from '../../lib/format.js';
import { mergeRows } from '../../lib/merge.js';
import { hostVariants, pathVariants, toUrlKey, urlKeyHost, urlKeyPath } from '../../lib/urlKey.js';
import type { ServerContext } from '../context.js';
import { runReport } from '../report.js';
import {
    dateArgs, defineTool, derivePageRatios, envelope, filtersArg, formatArg, LANDING_METRICS, limitArg, PAGE_METRICS, propertyArg,
    resolveRanges,
} from './shared.js';

const ORGANIC = 'sessionDefaultChannelGroup==Organic Search';
const APPROX_USERS = 'totalUsers/newUsers were summed across URL variants (e.g. with and without a trailing slash), so they may slightly over-count.';

/** Fetch page rows, add url_key, merge variants, derive ratios, sort and cut. */
async function pageRows(
    ctx: ServerContext,
    property: Awaited<ReturnType<ServerContext['property']>>,
    options: { pathDim: 'pagePath' | 'landingPage'; metrics: string[]; ranges: ReturnType<typeof resolveRanges>['ranges']; filters?: string[]; dimensionFilter?: any; sortBy: string; limit: number; fetchLimit: number },
) {
    const result = await runReport(ctx, property, {
        dimensions: ['hostName', options.pathDim],
        metrics: options.metrics,
        ranges: options.ranges,
        filters: options.filters,
        dimensionFilter: options.dimensionFilter,
        orderBy: `-${options.sortBy}`,
        limit: options.fetchLimit,
    });
    const keyed = addUrlKeys(result.parsed.rows, result.parsed.dimensions, property.hosts[0]);
    const merged = mergeRows(keyed, (r) => r.url_key as string | null, options.metrics, ['url_key', options.pathDim]);
    const rows = merged.rows
        .map(derivePageRatios)
        .sort((a, b) => ((b[options.sortBy] as number) ?? 0) - ((a[options.sortBy] as number) ?? 0));
    return { result, rows, approximateUsers: merged.approximateUsers, truncated: result.parsed.rowCount > options.fetchLimit };
}

export function registerPageTools(server: McpServer, ctx: ServerContext): void {
    defineTool(
        server,
        ctx,
        'ga_top_pages',
        {
            title: 'Top pages',
            description:
                'Most viewed pages with views, sessions, users, engagement rate, average engagement time per view and key events. ' +
                'Rows are keyed by url_key (joins with AdSense PAGE_URL, Search Console page and Ahrefs URLs).',
            inputSchema: {
                property: propertyArg,
                ...dateArgs,
                orderBy: z.enum(['screenPageViews', 'sessions', 'totalUsers', 'engagedSessions', 'userEngagementDuration', 'keyEvents']).optional().describe('Sort metric, descending. Default screenPageViews.'),
                pathPrefix: z.string().optional().describe('Only paths starting with this, e.g. "/blog/".'),
                filters: filtersArg,
                limit: limitArg(25, 1000),
                format: formatArg,
            },
        },
        async (args) => {
            const property = await ctx.property(args.property);
            const { ranges } = resolveRanges(property.timeZone, args, 'none');
            const limit = args.limit ?? 25;
            const sortBy = args.orderBy ?? 'screenPageViews';
            const filters = [...(args.filters ?? []), ...(args.pathPrefix ? [`pagePath=^${args.pathPrefix}`] : [])];
            const { result, rows, approximateUsers, truncated } = await pageRows(ctx, property, {
                pathDim: 'pagePath', metrics: PAGE_METRICS, ranges, filters, sortBy, limit, fetchLimit: Math.min(10000, Math.max(100, limit * 3)),
            });
            const top = rows[0];
            return envelope({
                property,
                ranges,
                summary: top
                    ? `${result.parsed.rowCount} page paths; top: ${top.url_key} with ${fmt(top.screenPageViews as number, 'int')} views ` +
                      `(${fmt(top.engagement_rate as number, 'pct')} engaged sessions).`
                    : 'No page views in this date range.',
                totals: result.parsed.totals,
                rows: rows.slice(0, limit),
                format: args.format,
                rowCount: rows.length,
                warnings: [...result.warnings, ...(approximateUsers ? [APPROX_USERS] : []), ...(truncated ? ['Only the top pages were fetched; narrow with pathPrefix/filters for more.'] : [])],
                quota: result.quota,
            });
        },
    );

    defineTool(
        server,
        ctx,
        'ga_landing_pages',
        {
            title: 'Landing pages',
            description:
                'Pages where sessions start, with sessions, users, new users, engagement rate, engagement time and key events per session. ' +
                'organicOnly=true keeps Organic Search sessions: these rows join with Search Console "page" data on url_key ' +
                '(GSC clicks -> GA sessions -> key events).',
            inputSchema: {
                property: propertyArg,
                ...dateArgs,
                organicOnly: z.boolean().optional().describe('Only Organic Search sessions.'),
                channel: z.string().optional().describe('Only this channel group, e.g. "Referral", "Organic Social".'),
                orderBy: z.enum(['sessions', 'totalUsers', 'newUsers', 'engagedSessions', 'keyEvents']).optional().describe('Default sessions.'),
                filters: filtersArg,
                limit: limitArg(25, 1000),
                format: formatArg,
            },
        },
        async (args) => {
            if (args.organicOnly && args.channel) throw new UserInputError('Use either organicOnly or channel, not both.');
            const property = await ctx.property(args.property);
            const { ranges } = resolveRanges(property.timeZone, args, 'none');
            const limit = args.limit ?? 25;
            const sortBy = args.orderBy ?? 'sessions';
            const filters = [
                ...(args.filters ?? []),
                ...(args.organicOnly ? [ORGANIC] : []),
                ...(args.channel ? [`sessionDefaultChannelGroup==${args.channel}`] : []),
            ];
            const { result, rows, approximateUsers, truncated } = await pageRows(ctx, property, {
                pathDim: 'landingPage', metrics: LANDING_METRICS, ranges, filters, sortBy, limit, fetchLimit: Math.min(10000, Math.max(100, limit * 3)),
            });
            const withBounce = rows.map((r): Row => ({ ...r, bounce_rate: r.engagement_rate === null ? null : Math.round((1 - (r.engagement_rate as number)) * 1000) / 1000 }));
            const top = withBounce[0];
            return envelope({
                property,
                ranges,
                summary: top
                    ? `${result.parsed.rowCount} landing pages${args.organicOnly ? ' (organic search)' : args.channel ? ` (${args.channel})` : ''}; ` +
                      `top: ${top.url_key} with ${fmt(top.sessions as number, 'int')} sessions, ${fmt(top.engagement_rate as number, 'pct')} engaged.`
                    : 'No sessions in this date range.',
                totals: result.parsed.totals,
                rows: withBounce.slice(0, limit),
                format: args.format,
                rowCount: withBounce.length,
                warnings: [...result.warnings, ...(approximateUsers ? [APPROX_USERS] : []), ...(truncated ? ['Only the top landing pages were fetched; narrow with filters for more.'] : [])],
                quota: result.quota,
            });
        },
    );

    defineTool(
        server,
        ctx,
        'ga_pages_by_url',
        {
            title: 'GA4 metrics for a list of URLs',
            description:
                'The join tool: give it URLs from Search Console, AdSense (PAGE_URL), Ahrefs or a sitemap and get GA4 metrics for each, ' +
                'matched on url_key (www, trailing slash, /index.html, query strings and case of the host are normalized). ' +
                'mode=landing (+ organicOnly) for SEO questions ("what happens after the click?"); mode=page for page views, e.g. alongside AdSense. ' +
                'URLs not found in GA4 come back with found:false.',
            inputSchema: {
                property: propertyArg.describe('GA4 property; default: the property tracking the first URL\'s host.'),
                urls: z.array(z.string()).min(1).max(200).describe('Full URLs or host/path values (max 200).'),
                mode: z.enum(['page', 'landing']).optional().describe('page: pagePath metrics (default). landing: sessions that started on the URL.'),
                organicOnly: z.boolean().optional().describe('Only Organic Search sessions (best with mode=landing).'),
                ...dateArgs,
                format: formatArg,
            },
        },
        async (args) => {
            const requested = args.urls.map((url) => ({ url, key: toUrlKey(url) }));
            const firstKey = requested.find((r) => r.key)?.key;
            if (!firstKey) throw new UserInputError('None of the URLs could be parsed. Pass full URLs like https://example.com/page.');
            const property = await ctx.property(args.property ?? urlKeyHost(firstKey));
            const { ranges } = resolveRanges(property.timeZone, args, 'none');
            const mode = args.mode ?? 'page';
            const pathDim = mode === 'landing' ? 'landingPage' : 'pagePath';
            const metrics = mode === 'landing' ? LANDING_METRICS : PAGE_METRICS;

            const keys = [...new Set(requested.map((r) => r.key).filter((k): k is string => !!k))];
            const hosts = [...new Set(keys.map(urlKeyHost))];
            const paths = [...new Set(keys.map(urlKeyPath).flatMap(pathVariants))];
            const { result, rows } = await pageRows(ctx, property, {
                pathDim,
                metrics,
                ranges,
                filters: args.organicOnly ? [ORGANIC] : undefined,
                dimensionFilter: andExpressions(inListExpression('hostName', hosts.flatMap(hostVariants), false), inListExpression(pathDim, paths)),
                sortBy: metrics[0],
                limit: 10000,
                fetchLimit: 10000,
            });
            const byKey = new Map(rows.map((r) => [r.url_key as string, r]));
            const out: Row[] = requested.map(({ url, key }) => {
                const row = key ? byKey.get(key) : undefined;
                if (!row) return { url, url_key: key, found: false };
                const { url_key: _k, [pathDim]: _p, ...metricsOnly } = row;
                return { url, url_key: key, found: true, ...metricsOnly };
            });
            const found = out.filter((r) => r.found).length;
            const otherHosts = hosts.filter((h) => property.hosts.length > 0 && !property.hosts.includes(h) && !property.hosts.some((ph) => h.endsWith(`.${ph}`)));
            return envelope({
                property,
                ranges,
                summary: `GA4 data found for ${found} of ${out.length} URLs (${mode === 'landing' ? `landing pages${args.organicOnly ? ', organic search' : ''}` : 'page views'}).`,
                rows: out,
                format: args.format ?? 'full',
                rowCount: out.length,
                warnings: [
                    ...result.warnings,
                    ...(otherHosts.length ? [`Some URLs are on hosts this property doesn't track (${otherHosts.join(', ')}); query their own property.`] : []),
                ],
                quota: result.quota,
                extra: { matched: found, requested: out.length },
            });
        },
    );
}
