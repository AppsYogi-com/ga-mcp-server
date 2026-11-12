/**
 * Discovery tools: which properties exist and which sites they track, property details,
 * field search, and URL normalization for joins.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { lastDays } from '../../lib/dates.js';
import { shapeRows } from '../../lib/format.js';
import { normalizeHost, toUrlKey } from '../../lib/urlKey.js';
import type { ServerContext } from '../context.js';
import { runReport } from '../report.js';
import { defineTool, formatArg, propertyArg, propertyInfo } from './shared.js';

export function registerDiscoveryTools(server: McpServer, ctx: ServerContext): void {
    defineTool(
        server,
        ctx,
        'ga_list_properties',
        {
            title: 'List GA4 properties and their sites',
            description:
                'List every GA4 property this account can see, with the site hosts it tracks (from web data streams). ' +
                'Use it to map Search Console properties, AdSense sites and Ahrefs targets to GA4 property ids. ' +
                'Hosts are normalized like url_key (lowercase, "www." removed). ' +
                'includeObservedHosts adds the hostnames actually seen in traffic over the last 28 days (one small report per property).',
            inputSchema: {
                host: z.string().optional().describe('Only properties tracking this host/URL ("example.com", "https://www.example.com/", "sc-domain:example.com").'),
                includeObservedHosts: z.boolean().optional().describe('Also report hostnames seen in traffic (last 28 days). Default false.'),
            },
        },
        async ({ host, includeObservedHosts }) => {
            let properties = host ? await ctx.propertiesForHost(host) : await ctx.propertyMap();
            if (includeObservedHosts) {
                properties = await Promise.all(
                    properties.map(async (p) => {
                        try {
                            const details = await ctx.property(p.property_id);
                            const { parsed } = await runReport(ctx, details, {
                                dimensions: ['hostName'],
                                metrics: ['sessions'],
                                ranges: [lastDays(28, details.timeZone)],
                                orderBy: '-sessions',
                                limit: 10,
                            });
                            const observed = parsed.rows
                                .map((r) => ({ host: normalizeHost(r.hostName as string), raw: r.hostName, sessions: r.sessions }))
                                .filter((r) => r.host);
                            return { ...p, observed_hosts: observed };
                        } catch {
                            return { ...p, observed_hosts: null };
                        }
                    }),
                );
            }
            const normalized = host ? normalizeHost(host) : null;
            return {
                summary: host
                    ? `${properties.length} GA4 propert${properties.length === 1 ? 'y tracks' : 'ies track'} ${normalized ?? host}.`
                    : `${properties.length} GA4 properties visible to this account.`,
                default_property: ctx.defaultProperty ?? null,
                properties,
            };
        },
    );

    defineTool(
        server,
        ctx,
        'ga_get_property',
        {
            title: 'GA4 property details',
            description:
                'Time zone, currency, web streams (site URLs), key events (conversions), custom dimensions/metrics (with their API names ' +
                'for reports, e.g. customEvent:plan) and whether AdSense is linked (needed for totalAdRevenue/publisherAd* metrics).',
            inputSchema: { property: propertyArg },
        },
        async ({ property }) => {
            const p = await ctx.property(property);
            const client = await ctx.client();
            const [streams, keyEvents, customDimensions, customMetrics, adsenseLinks] = await Promise.all([
                client.listDataStreams(p.id),
                client.listKeyEvents(p.id).catch(() => []),
                client.listCustomDimensions(p.id).catch(() => []),
                client.listCustomMetrics(p.id).catch(() => []),
                client.listAdSenseLinks(p.id),
            ]);
            const scopePrefix: Record<string, string> = { EVENT: 'customEvent', USER: 'customUser', ITEM: 'customItem' };
            return {
                property: propertyInfo(p),
                service_level: p.serviceLevel,
                industry: p.industryCategory,
                created: p.createTime,
                streams: streams.map((s) => ({ id: s.id, name: s.displayName, type: s.type, default_uri: s.defaultUri, measurement_id: s.measurementId })),
                key_events: keyEvents.map((k) => k.eventName),
                custom_dimensions: customDimensions.map((d) => ({
                    api_name: `${scopePrefix[d.scope] ?? 'customEvent'}:${d.parameterName}`,
                    name: d.displayName,
                    scope: d.scope,
                })),
                custom_metrics: customMetrics.map((m) => ({ api_name: `customEvent:${m.parameterName}`, name: m.displayName, unit: m.unit })),
                adsense_linked: adsenseLinks === null ? 'unknown' : adsenseLinks.length > 0,
                adsense_ad_clients: adsenseLinks?.map((l) => l.adClientCode) ?? [],
            };
        },
    );

    defineTool(
        server,
        ctx,
        'ga_search_fields',
        {
            title: 'Search GA4 dimensions and metrics',
            description:
                'Find dimension and metric API names (including the property\'s custom fields) by keyword, and optionally keep only ' +
                'fields compatible with a planned report. Use before ga_run_report when unsure of a field name.',
            inputSchema: {
                property: propertyArg,
                query: z.string().optional().describe('Keyword matched against API name, UI name, category and description (e.g. "landing", "revenue").'),
                kind: z.enum(['all', 'dimension', 'metric']).optional().describe('Default all.'),
                customOnly: z.boolean().optional().describe('Only custom dimensions/metrics.'),
                compatibleWith: z
                    .object({ dimensions: z.array(z.string()).optional(), metrics: z.array(z.string()).optional() })
                    .optional()
                    .describe('Only fields that can be combined with these dimensions/metrics in one report.'),
                limit: z.number().int().min(1).max(500).optional().describe('Maximum fields (default 50).'),
                format: formatArg,
            },
        },
        async ({ property, query, kind = 'all', customOnly, compatibleWith, limit = 50, format = 'compact' }) => {
            const propertyId = property || ctx.defaultProperty ? (await ctx.property(property)).id : '0';
            let fields = await ctx.metadata(propertyId);
            if (kind !== 'all') fields = fields.filter((f) => f.kind === kind);
            if (customOnly) fields = fields.filter((f) => f.custom);
            if (compatibleWith && (compatibleWith.dimensions?.length || compatibleWith.metrics?.length)) {
                const client = await ctx.client();
                const compatible = await client.checkCompatibility(propertyId === '0' ? (await ctx.property()).id : propertyId, {
                    dimensions: (compatibleWith.dimensions ?? []).map((name) => ({ name })),
                    metrics: (compatibleWith.metrics ?? []).map((name) => ({ name })),
                    compatibilityFilter: 'COMPATIBLE',
                });
                const allowed = new Set([...compatible.dimensions, ...compatible.metrics]);
                fields = fields.filter((f) => allowed.has(f.apiName));
            }
            if (query) {
                const q = query.toLowerCase();
                const score = (f: (typeof fields)[number]) =>
                    f.apiName.toLowerCase().includes(q) || f.uiName.toLowerCase().includes(q) ? 0 : 1;
                fields = fields
                    .filter((f) => [f.apiName, f.uiName, f.category, f.description].some((v) => v.toLowerCase().includes(q)))
                    .sort((a, b) => score(a) - score(b));
            }
            const rows = fields.slice(0, limit).map((f) => ({
                api_name: f.apiName,
                ui_name: f.uiName,
                kind: f.kind,
                category: f.category,
                type: f.type ?? null,
                custom: f.custom,
                ...(format === 'full' ? { description: f.description } : {}),
            }));
            return {
                summary: `${fields.length} matching field${fields.length === 1 ? '' : 's'}${fields.length > limit ? `, showing ${limit}` : ''}.`,
                property: propertyId === '0' ? null : propertyId,
                ...shapeRows(rows, format),
                total: fields.length,
            };
        },
    );

    defineTool(
        server,
        ctx,
        'ga_normalize_urls',
        {
            title: 'Normalize URLs to url_key',
            description:
                'Turn Search Console, AdSense, Ahrefs or any other URLs into url_key values, the join key used by every GA page row: ' +
                'lowercase host without "www.", path with case kept, no query string or fragment, no trailing slash or /index.html. ' +
                'Example: https://www.Example.com/Blog/?utm_source=x -> example.com/Blog. No API call.',
            inputSchema: {
                urls: z.array(z.string()).min(1).max(1000).describe('URLs or "host/path" values (max 1000).'),
            },
            openWorld: false,
        },
        async ({ urls }) => ({ results: urls.map((url) => ({ url, url_key: toUrlKey(url) })) }),
    );
}
