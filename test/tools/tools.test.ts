import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { NotConfiguredError } from '../../src/auth/config.js';
import type { GaClient } from '../../src/ga/client.js';
import type { GaReportResponse } from '../../src/lib/format.js';
import { createServer } from '../../src/server/index.js';

type Fixture = Record<string, string | number>;

/** Build a GA report response from plain row objects. */
function gaResponse(dimensions: string[], metrics: string[], rows: Fixture[], totals?: Fixture | Fixture[]): GaReportResponse {
    const toRow = (r: Fixture) => ({
        dimensionValues: dimensions.map((d) => ({ value: String(r[d] ?? '') })),
        metricValues: metrics.map((m) => ({ value: String(r[m] ?? 0) })),
    });
    const totalRows = totals ? (Array.isArray(totals) ? totals : [totals]) : [];
    return {
        dimensionHeaders: dimensions.map((name) => ({ name })),
        metricHeaders: metrics.map((name) => ({ name, type: name.endsWith('Rate') ? 'TYPE_FLOAT' : 'TYPE_INTEGER' })),
        rows: rows.map(toRow),
        totals: totalRows.map(toRow),
        rowCount: rows.length,
        metadata: { currencyCode: 'USD', timeZone: 'UTC' },
        propertyQuota: { tokensPerDay: { consumed: 10, remaining: 199990 }, tokensPerHour: { consumed: 10, remaining: 39990 }, tokensPerProjectPerHour: { consumed: 10, remaining: 13990 } },
    };
}

const names = (request: Record<string, any>, key: 'dimensions' | 'metrics') => (request[key] ?? []).map((x: { name: string }) => x.name);

/** A fake GA client: two properties, fixture reports chosen by the requested dimensions. */
function fakeClient(requests: { method: string; propertyId: string; request: any }[] = []): GaClient {
    const report = (propertyId: string, request: any): GaReportResponse => {
        requests.push({ method: 'runReport', propertyId, request });
        const dims = names(request, 'dimensions');
        const metrics = names(request, 'metrics');
        const ranges = (request.dateRanges ?? []).map((r: any) => r.name);
        const key = dims.join(',');
        if (key === 'hostName,pagePath') {
            const filtered = JSON.stringify(request.dimensionFilter ?? {});
            const rows = [
                { hostName: 'www.example.com', pagePath: '/blog/', screenPageViews: 100, sessions: 80, totalUsers: 70, engagedSessions: 40, userEngagementDuration: 2000, keyEvents: 2 },
                { hostName: 'example.com', pagePath: '/blog', screenPageViews: 50, sessions: 20, totalUsers: 15, engagedSessions: 10, userEngagementDuration: 500, keyEvents: 1 },
                { hostName: 'example.com', pagePath: '/pricing', screenPageViews: 60, sessions: 30, totalUsers: 25, engagedSessions: 25, userEngagementDuration: 900, keyEvents: 6 },
            ].filter((r) => !filtered.includes('inListFilter') || filtered.includes(`"${r.pagePath}"`));
            return gaResponse(dims, metrics, rows, { screenPageViews: 210, sessions: 130 });
        }
        if (key === 'sessionDefaultChannelGroup' && ranges.includes('previous')) {
            return gaResponse(['sessionDefaultChannelGroup', 'dateRange'], metrics, [
                { sessionDefaultChannelGroup: 'Organic Search', dateRange: 'current', sessions: 600, totalUsers: 500, engagedSessions: 300, keyEvents: 12 },
                { sessionDefaultChannelGroup: 'Organic Search', dateRange: 'previous', sessions: 500, totalUsers: 400, engagedSessions: 250, keyEvents: 10 },
                { sessionDefaultChannelGroup: 'Direct', dateRange: 'current', sessions: 400, totalUsers: 350, engagedSessions: 200, keyEvents: 8 },
            ]);
        }
        if (key === '' && ranges.includes('previous')) {
            return gaResponse(['dateRange'], metrics, [
                { dateRange: 'current', sessions: 1000, totalUsers: 850, engagementRate: 0.55, keyEvents: 20, userEngagementDuration: 50000 },
                { dateRange: 'previous', sessions: 800, totalUsers: 700, engagementRate: 0.5, keyEvents: 16, userEngagementDuration: 40000 },
            ]);
        }
        if (key === 'country') {
            const isPrevious = request.dateRanges[0].startDate < '2026-01-01' || JSON.stringify(request.dimensionFilter ?? {}).includes('inListFilter');
            return isPrevious
                ? gaResponse(dims, metrics, [{ country: 'India', sessions: 50 }, { country: 'US', sessions: 40 }])
                : gaResponse(dims, metrics, [{ country: 'India', sessions: 70 }, { country: 'US', sessions: 30 }], { sessions: 100 });
        }
        if (key === '') return gaResponse([], metrics, [{ sessions: 90 }], { sessions: 90 });
        return gaResponse(dims, metrics, []);
    };
    return {
        listPropertySummaries: async () => [
            { id: '111', displayName: 'Example site', accountId: '1', accountName: 'Account' },
            { id: '222', displayName: 'Tools', accountId: '1', accountName: 'Account' },
        ],
        getProperty: async (id) => ({ id, displayName: id === '111' ? 'Example site' : 'Tools', timeZone: 'UTC', currencyCode: 'USD', serviceLevel: null, industryCategory: null, createTime: null }),
        listDataStreams: async (id) => [
            { id: `s${id}`, displayName: 'Web', type: 'WEB_DATA_STREAM', defaultUri: id === '111' ? 'https://www.example.com' : 'https://tools.example.org', measurementId: 'G-X' },
        ],
        listKeyEvents: async () => [{ eventName: 'sign_up', countingMethod: null, createTime: null }],
        listCustomDimensions: async () => [{ parameterName: 'plan', displayName: 'Plan', scope: 'EVENT' }],
        listCustomMetrics: async () => [],
        listAdSenseLinks: async () => [{ adClientCode: 'ca-pub-1' }],
        runReport: async (id, request) => report(id, request),
        batchRunReports: async (id, list) => list.map((request) => report(id, request)),
        runRealtimeReport: async (_id, request) => gaResponse(names(request, 'dimensions'), names(request, 'metrics'), [{ unifiedScreenName: 'Home', activeUsers: 3 }], { activeUsers: 3 }),
        getMetadata: async () => [
            { apiName: 'pagePath', uiName: 'Page path', description: 'Path', category: 'Page', kind: 'dimension', custom: false },
            { apiName: 'customEvent:plan', uiName: 'Plan', description: 'Plan', category: 'Custom', kind: 'dimension', custom: true },
            { apiName: 'sessions', uiName: 'Sessions', description: 'Sessions', category: 'Session', kind: 'metric', custom: false },
        ],
        checkCompatibility: async () => ({ dimensions: ['pagePath'], metrics: ['sessions'] }),
        runFunnelReport: async (id, request) => {
            requests.push({ method: 'runFunnelReport', propertyId: id, request });
            const table = gaResponse(['funnelStepName'], ['activeUsers', 'funnelStepCompletionRate'], [
                { funnelStepName: '1. Landing', activeUsers: 100, funnelStepCompletionRate: 0.4 },
                { funnelStepName: '2. Sign-up', activeUsers: 40, funnelStepCompletionRate: 0 },
            ]);
            // Real GA4 funnel tables repeat every metric header.
            table.metricHeaders = [...table.metricHeaders!, ...table.metricHeaders!];
            return { funnelTable: table };
        },
    };
}

async function connect(client: GaClient | (() => Promise<GaClient>), defaultProperty?: string) {
    const { server } = createServer({ clientFactory: typeof client === 'function' ? client : async () => client, defaultProperty });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: 'test', version: '0.0.0' });
    await mcp.connect(clientTransport);
    return mcp;
}

async function call(mcp: Client, name: string, args: Record<string, unknown> = {}) {
    const result = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = result.content[0].text;
    return { isError: !!result.isError, text, json: result.isError ? null : JSON.parse(text) };
}

describe('tool registry', () => {
    it('lists all tools with valid names and read-only annotations, without credentials', async () => {
        const mcp = await connect(async () => {
            throw new NotConfiguredError();
        });
        const { tools } = await mcp.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
            'ga_acquisition', 'ga_compare_periods', 'ga_declining_pages', 'ga_engagement_gaps', 'ga_get_property', 'ga_key_events',
            'ga_landing_pages', 'ga_list_properties', 'ga_normalize_urls', 'ga_pages_by_url', 'ga_run_funnel_report', 'ga_run_realtime_report',
            'ga_run_report', 'ga_search_fields', 'ga_top_pages', 'ga_traffic_overview',
        ]);
        for (const tool of tools) {
            expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
            expect(tool.annotations?.readOnlyHint).toBe(true);
            expect(tool.description!.length).toBeGreaterThan(40);
        }
        expect(mcp.getInstructions()).toContain('url_key');
    });

    it('explains how to sign in when a tool needs Google and there is no sign-in', async () => {
        const mcp = await connect(async () => {
            throw new NotConfiguredError();
        });
        const result = await call(mcp, 'ga_list_properties');
        expect(result.isError).toBe(true);
        expect(result.text).toContain('ga-mcp init');
    });

    it('normalizes URLs without calling Google', async () => {
        const mcp = await connect(async () => {
            throw new Error('should not be called');
        });
        const result = await call(mcp, 'ga_normalize_urls', { urls: ['https://www.Example.com/Blog/?utm=1', '/nope'] });
        expect(result.json.results).toEqual([
            { url: 'https://www.Example.com/Blog/?utm=1', url_key: 'example.com/Blog' },
            { url: '/nope', url_key: null },
        ]);
    });
});

describe('discovery tools', () => {
    it('maps properties to hosts and filters by any host form', async () => {
        const mcp = await connect(fakeClient());
        const all = await call(mcp, 'ga_list_properties');
        expect(all.json.properties.map((p: any) => [p.property_id, p.hosts])).toEqual([['111', ['example.com']], ['222', ['tools.example.org']]]);
        const one = await call(mcp, 'ga_list_properties', { host: 'sc-domain:example.com' });
        expect(one.json.properties.map((p: any) => p.property_id)).toEqual(['111']);
    });

    it('requires a property when several exist and there is no default', async () => {
        const mcp = await connect(fakeClient());
        const result = await call(mcp, 'ga_top_pages');
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/can see 2 GA4 properties/);
    });

    it('returns property details with custom field API names and AdSense link status', async () => {
        const mcp = await connect(fakeClient());
        const result = await call(mcp, 'ga_get_property', { property: 'https://example.com/anything' });
        expect(result.json.property.id).toBe('111');
        expect(result.json.custom_dimensions[0].api_name).toBe('customEvent:plan');
        expect(result.json.key_events).toEqual(['sign_up']);
        expect(result.json.adsense_linked).toBe(true);
    });

    it('searches fields including custom ones', async () => {
        const mcp = await connect(fakeClient(), '111');
        const result = await call(mcp, 'ga_search_fields', { query: 'plan', format: 'full' });
        expect(result.json.rows.map((r: any) => r.api_name)).toEqual(['customEvent:plan']);
    });
});

describe('report tools', () => {
    it('compiles friendly filters (including custom fields) and adds totals and quota', async () => {
        const requests: any[] = [];
        const mcp = await connect(fakeClient(requests), '111');
        const result = await call(mcp, 'ga_run_report', {
            dimensions: ['pagePath'],
            metrics: ['sessions'],
            filters: ['pagePath=^/blog', 'customEvent:plan==pro', 'sessions>5'],
            dateRange: 'last7d',
        });
        expect(result.isError).toBe(false);
        const request = requests.at(-1).request;
        expect(names(request, 'dimensions')).toEqual(['pagePath', 'hostName']); // hostName added for url_key
        expect(request.dimensionFilter.andGroup.expressions).toHaveLength(2);
        expect(request.metricFilter.filter.numericFilter.operation).toBe('GREATER_THAN');
        expect(request.metricAggregations).toEqual(['TOTAL']);
        expect(request.returnPropertyQuota).toBe(true);
        expect(request.orderBys).toEqual([{ metric: { metricName: 'sessions' }, desc: true }]);
        expect(result.json.quota.tokens_today_left).toBe(199990);
    });

    it('rejects bad filters with a helpful message', async () => {
        const mcp = await connect(fakeClient(), '111');
        const result = await call(mcp, 'ga_run_report', { metrics: ['sessions'], filters: ['pagePath=/x'] });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('Use == for an exact match');
    });

    it('runs realtime reports', async () => {
        const mcp = await connect(fakeClient(), '111');
        const result = await call(mcp, 'ga_run_realtime_report', { format: 'full' });
        expect(result.json.summary).toContain('3 activeUsers');
        expect(result.json.rows).toEqual([{ unifiedScreenName: 'Home', activeUsers: 3 }]);
    });

    it('builds funnel steps from events and filters, mapping pagePath to a funnel field', async () => {
        const requests: any[] = [];
        const mcp = await connect(fakeClient(requests), '111');
        const result = await call(mcp, 'ga_run_funnel_report', {
            steps: [{ name: 'Landing', filters: ['pagePath==/'] }, { name: 'Sign-up', event: 'sign_up' }],
        });
        expect(result.json.summary).toContain('1. Landing 100 → 2. Sign-up 40 (40% overall)');
        expect(result.json.steps).toEqual([{ step: '1. Landing', active_users: 100 }, { step: '2. Sign-up', active_users: 40 }]);
        expect(result.json.warnings[0]).toContain('v1alpha');
        expect(result.json.warnings.some((w: string) => w.includes('unifiedPagePathScreen'))).toBe(true);
        const steps = requests.find((r) => r.method === 'runFunnelReport').request.funnel.steps;
        expect(steps[0].filterExpression.funnelFieldFilter.fieldName).toBe('unifiedPagePathScreen');
        expect(steps[1].filterExpression).toEqual({ funnelEventFilter: { eventName: 'sign_up' } });
    });

    it('rejects landingPage in funnel steps with a suggestion', async () => {
        const mcp = await connect(fakeClient(), '111');
        const result = await call(mcp, 'ga_run_funnel_report', {
            steps: [{ name: 'Landing', filters: ['landingPage==/'] }, { name: 'Sign-up', event: 'sign_up' }],
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("can't be used in funnel steps");
    });
});

describe('opinionated tools', () => {
    it('merges URL variants into one url_key with recomputed ratios', async () => {
        const mcp = await connect(fakeClient(), '111');
        const result = await call(mcp, 'ga_top_pages', { format: 'full' });
        const blog = result.json.rows.find((r: any) => r.url_key === 'example.com/blog');
        expect(blog.screenPageViews).toBe(150);
        expect(blog.sessions).toBe(100);
        expect(blog.engagement_rate).toBe(0.5);
        expect(result.json.rows[0].url_key).toBe('example.com/blog');
        expect(result.json.warnings.some((w: string) => w.includes('over-count'))).toBe(true);
    });

    it('joins a URL list on url_key and reports misses', async () => {
        const requests: any[] = [];
        const mcp = await connect(fakeClient(requests));
        const result = await call(mcp, 'ga_pages_by_url', {
            urls: ['https://example.com/blog/', 'https://www.example.com/pricing?x=1', 'https://example.com/missing'],
        });
        expect(result.json.property.id).toBe('111'); // resolved from the first URL's host
        expect(result.json.rows.map((r: any) => [r.url_key, r.found])).toEqual([
            ['example.com/blog', true],
            ['example.com/pricing', true],
            ['example.com/missing', false],
        ]);
        const filter = JSON.stringify(requests.at(-1).request.dimensionFilter);
        expect(filter).toContain('www.example.com');
        expect(filter).toContain('/blog/');
    });

    it('summarizes traffic with period comparison and channel shares', async () => {
        const mcp = await connect(fakeClient(), '111');
        const result = await call(mcp, 'ga_traffic_overview', { format: 'full' });
        const sessions = result.json.kpis.find((k: any) => k.metric === 'sessions');
        expect(sessions).toEqual({ metric: 'sessions', current: 1000, previous: 800, change_pct: 25 });
        expect(result.json.rows[0].sessionDefaultChannelGroup).toBe('Organic Search');
        expect(result.json.rows[0].share_pct).toBe(60);
        expect(result.json.summary).toContain('Sessions 1,000 (+25%)');
    });

    it('compares periods with exact lookups and real totals', async () => {
        const requests: any[] = [];
        const mcp = await connect(fakeClient(requests), '111');
        const result = await call(mcp, 'ga_compare_periods', {
            dimensions: ['country'], metrics: ['sessions'], startDate: '2026-02-01', endDate: '2026-02-28', format: 'full',
        });
        expect(result.json.rows).toEqual([
            { country: 'India', sessions: 70, sessions_prev: 50, sessions_change: 20, sessions_change_pct: 40 },
            { country: 'US', sessions: 30, sessions_prev: 40, sessions_change: -10, sessions_change_pct: -25 },
        ]);
        expect(result.json.totals.sessions).toEqual({ current: 100, previous: 90, change_pct: 11.1 });
        const lookup = requests.at(-1).request;
        expect(lookup.dimensionFilter.filter.inListFilter.values).toEqual(['India', 'US']);
    });
});
