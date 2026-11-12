/**
 * Helpers shared by all tools: common input schemas, tool registration with uniform error
 * handling, and the response envelope.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PropertyDetails } from '../../ga/client.js';
import { explainError } from '../../ga/errors.js';
import { comparisonRange, DATE_PRESETS, resolveDateRange, type CompareMode, type DateInput, type DateRange } from '../../lib/dates.js';
import { ratio, shapeRows, type OutputFormat, type Row } from '../../lib/format.js';
import type { QuotaSummary } from '../../lib/quota.js';
import type { ServerContext } from '../context.js';

// ---- input schema fragments -------------------------------------------------------------------

export const propertyArg = z
    .string()
    .optional()
    .describe('GA4 property: an id ("123456789"), "properties/123", or a site host/URL ("example.com", "sc-domain:example.com"). Defaults to the server default.');

export const dateArgs = {
    dateRange: z.enum(DATE_PRESETS).optional().describe('Preset range ending yesterday (this_month ends today). Default: last28d.'),
    startDate: z.string().optional().describe('Start date: YYYY-MM-DD, NdaysAgo, yesterday or today (property time zone). Use instead of dateRange.'),
    endDate: z.string().optional().describe('End date: YYYY-MM-DD, NdaysAgo, yesterday or today. Default: yesterday.'),
};

export const compareArg = z
    .enum(['previous_period', 'previous_year', 'none'])
    .optional()
    .describe('Compare with the previous period (same length, just before) or the previous year (364 days back, weekdays aligned).');

export const filtersArg = z
    .array(z.string())
    .optional()
    .describe(
        'Filters, ANDed. Dimensions: == != =@ (contains) !@ =^ (begins) =$ (ends) =~ (regex) !~ and field=[a,b]. ' +
            'Metrics: > < >= <= == != (applied after aggregation). Use || inside one entry for OR. ' +
            'Examples: "sessionDefaultChannelGroup==Organic Search", "pagePath=^/blog", "sessions>=50".',
    );

export const formatArg = z
    .enum(['compact', 'full'])
    .optional()
    .describe('compact (default): columns + row arrays, fewer tokens. full: one object per row.');

export const limitArg = (defaultValue: number, max = 10000) =>
    z.number().int().min(1).max(max).optional().describe(`Maximum rows (default ${defaultValue}, max ${max}).`);

export const offsetArg = z.number().int().min(0).optional().describe('Row offset for pagination (use next_offset from the previous response).');

// ---- registration --------------------------------------------------------------------------------

export interface ToolDefinition<Shape extends z.ZodRawShape> {
    title: string;
    description: string;
    inputSchema: Shape;
    /** false for pure tools that never call Google (e.g. ga_normalize_urls). */
    openWorld?: boolean;
}

type Args<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

export function defineTool<Shape extends z.ZodRawShape>(
    server: McpServer,
    ctx: ServerContext,
    name: string,
    definition: ToolDefinition<Shape>,
    handler: (args: Args<Shape>, ctx: ServerContext) => Promise<unknown>,
): void {
    server.registerTool(
        name,
        {
            title: definition.title,
            description: definition.description,
            inputSchema: definition.inputSchema,
            annotations: { title: definition.title, readOnlyHint: true, openWorldHint: definition.openWorld ?? true },
        },
        (async (args: Args<Shape>) => {
            try {
                const result = await handler(args, ctx);
                return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
            } catch (error) {
                return { content: [{ type: 'text' as const, text: `Error: ${explainError(error)}` }], isError: true };
            }
        }) as any,
    );
}

// ---- date ranges ---------------------------------------------------------------------------------

/** The current range (named "current" when comparing) and the optional comparison range ("previous"). */
export function resolveRanges(
    timeZone: string,
    args: DateInput,
    compare: CompareMode | undefined,
): { current: DateRange; previous?: DateRange; ranges: DateRange[] } {
    const base = resolveDateRange(args, timeZone);
    const prev = comparisonRange(base, compare);
    if (!prev) return { current: base, ranges: [base] };
    const current = { ...base, name: 'current' };
    const previous = { ...prev, name: 'previous' };
    return { current, previous, ranges: [current, previous] };
}

// ---- page metrics --------------------------------------------------------------------------------

/** Additive metrics fetched for page-level tools; ratios are derived from them after merging by url_key. */
export const PAGE_METRICS = ['screenPageViews', 'sessions', 'totalUsers', 'engagedSessions', 'userEngagementDuration', 'keyEvents'];
export const LANDING_METRICS = ['sessions', 'totalUsers', 'newUsers', 'engagedSessions', 'userEngagementDuration', 'keyEvents'];

/** Engagement ratios computed from additive metrics. */
export function derivePageRatios(row: Row): Row {
    const sessions = row.sessions as number | null;
    const views = row.screenPageViews as number | null | undefined;
    return {
        ...row,
        engagement_rate: ratio(row.engagedSessions as number | null, sessions, 3),
        avg_engagement_sec: views !== undefined
            ? ratio(row.userEngagementDuration as number | null, views, 1)
            : ratio(row.userEngagementDuration as number | null, sessions, 1),
        key_events_per_session: ratio(row.keyEvents as number | null, sessions, 3),
    };
}

// ---- response envelope ---------------------------------------------------------------------------

export function propertyInfo(property: PropertyDetails & { hosts?: string[] }) {
    return {
        id: property.id,
        name: property.displayName,
        time_zone: property.timeZone,
        currency: property.currencyCode,
        hosts: property.hosts ?? [],
    };
}

export interface EnvelopeInput {
    property: PropertyDetails & { hosts?: string[] };
    ranges: DateRange[];
    summary: string;
    rows: Row[];
    format?: OutputFormat;
    columns?: string[];
    totals?: Record<string, unknown>;
    rowCount?: number;
    offset?: number;
    limit?: number;
    warnings?: string[];
    quota?: QuotaSummary | null;
    extra?: Record<string, unknown>;
}

export function envelope(input: EnvelopeInput) {
    const offset = input.offset ?? 0;
    const rowCount = input.rowCount ?? input.rows.length;
    const nextOffset = input.limit !== undefined && offset + input.rows.length < rowCount ? offset + input.rows.length : null;
    return {
        property: propertyInfo(input.property),
        date_ranges: input.ranges.map((r) => ({ ...(r.name ? { name: r.name } : {}), start: r.startDate, end: r.endDate })),
        summary: input.summary,
        ...(input.totals ? { totals: input.totals } : {}),
        ...input.extra,
        ...shapeRows(input.rows, input.format ?? 'compact', input.columns),
        row_count: rowCount,
        next_offset: nextOffset,
        warnings: input.warnings ?? [],
        quota: input.quota ?? null,
    };
}
