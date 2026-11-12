/**
 * Funnel reports (GA4 Data API v1alpha runFunnelReport, which Google may still change).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UserInputError } from '../../ga/errors.js';
import { compileFilters, toFunnelFilterExpression } from '../../lib/filters.js';
import { fmt, parseReport, type Row } from '../../lib/format.js';
import { parseQuota, quotaWarnings } from '../../lib/quota.js';
import { metadataWarnings, todayWarning, uniqueWarnings } from '../../lib/warnings.js';
import { filterFieldNames, type ServerContext } from '../context.js';
import { dateArgs, defineTool, envelope, formatArg, limitArg, propertyArg, resolveRanges } from './shared.js';

const ALPHA_WARNING = 'Funnel reports use the GA4 Data API v1alpha, which Google may change.';

/**
 * GA4 funnel steps use exploration field names: pagePath and landingPage are rejected
 * ("not currently supported inside segments & funnel steps"). Map pagePath to its
 * exploration equivalent and explain the rest.
 */
const FUNNEL_FIELD_MAP: Record<string, string> = { pagePath: 'unifiedPagePathScreen' };
const FUNNEL_UNSUPPORTED = new Set(['landingPage', 'landingPagePlusQueryString']);

export function toFunnelFilterStrings(filters: string[] | undefined, notes: Set<string>): string[] | undefined {
    return filters?.map((entry) =>
        entry
            .split('||')
            .map((part) => {
                const field = /^\s*([A-Za-z][A-Za-z0-9_]*)/.exec(part)?.[1];
                if (field && FUNNEL_UNSUPPORTED.has(field)) {
                    throw new UserInputError(
                        `${field} can't be used in funnel steps. Make the first step an event such as session_start, and filter a later step on unifiedPagePathScreen or pageLocation.`,
                    );
                }
                if (field && FUNNEL_FIELD_MAP[field]) {
                    notes.add(`${field} was mapped to ${FUNNEL_FIELD_MAP[field]} (GA4 funnels don't support ${field}).`);
                    return part.replace(field, FUNNEL_FIELD_MAP[field]);
                }
                return part;
            })
            .join('||'),
    );
}

const stepSchema = z.object({
    name: z.string().min(1).describe('Step label, e.g. "Viewed pricing".'),
    event: z.string().optional().describe('Event that completes the step, e.g. "page_view", "sign_up", "purchase".'),
    filters: z
        .array(z.string())
        .optional()
        .describe(
            'Dimension conditions for the step, same syntax as other tools (e.g. "pagePath=^/pricing"). ANDed with `event`. ' +
                'Funnels use exploration fields: pagePath is mapped to unifiedPagePathScreen; landingPage isn\'t supported.',
        ),
});

export function registerFunnelTools(server: McpServer, ctx: ServerContext): void {
    defineTool(
        server,
        ctx,
        'ga_run_funnel_report',
        {
            title: 'GA4 funnel report (alpha)',
            description:
                'Step-by-step funnel: how many users reach each step and where they drop off. Each step is an event and/or dimension filters, ' +
                'e.g. [{name:"Landing", filters:["pagePath==/"]}, {name:"Pricing", filters:["pagePath=^/pricing"]}, {name:"Sign-up", event:"sign_up"}]. ' +
                'Closed funnels (default) require users to enter at step 1; open funnels let users enter at any step. ' +
                'Optional breakdown by a dimension (e.g. deviceCategory) and trended view over time. Uses the v1alpha API.',
            inputSchema: {
                property: propertyArg,
                steps: z.array(stepSchema).min(2).max(10).describe('2-10 steps in order.'),
                open: z.boolean().optional().describe('Open funnel (users can enter at any step). Default false.'),
                breakdown: z.string().optional().describe('Dimension to split each step by, e.g. "deviceCategory" or "sessionDefaultChannelGroup".'),
                nextAction: z.string().optional().describe('Dimension describing what users did next, e.g. "eventName" or "pagePath".'),
                trended: z.boolean().optional().describe('Also return step counts over time.'),
                ...dateArgs,
                limit: limitArg(10, 100),
                format: formatArg,
            },
        },
        async (args) => {
            const property = await ctx.property(args.property);
            const { current } = resolveRanges(property.timeZone, args, 'none');
            const notes = new Set<string>();
            const stepFilters = args.steps.map((s) => toFunnelFilterStrings(s.filters, notes));
            const kindOf = await ctx.kindResolver(property.id, stepFilters.flatMap((f) => filterFieldNames(f)));

            const steps = args.steps.map((step, index) => {
                if (!step.event && !step.filters?.length) {
                    throw new UserInputError(`Funnel step "${step.name}" needs an event and/or filters.`);
                }
                const compiled = compileFilters(stepFilters[index], kindOf);
                if (compiled.metricFilter) throw new UserInputError(`Funnel step "${step.name}": steps can only filter on dimensions, not metrics.`);
                const parts: Record<string, unknown>[] = [];
                if (step.event) parts.push({ funnelEventFilter: { eventName: step.event } });
                if (compiled.dimensionFilter) parts.push(toFunnelFilterExpression(compiled.dimensionFilter));
                return { name: step.name, filterExpression: parts.length === 1 ? parts[0] : { andGroup: { expressions: parts } } };
            });

            const limit = args.limit ?? 10;
            const request: Record<string, unknown> = {
                dateRanges: [{ startDate: current.startDate, endDate: current.endDate }],
                funnel: { isOpenFunnel: !!args.open, steps },
                funnelVisualizationType: args.trended ? 'TRENDED_FUNNEL' : 'STANDARD_FUNNEL',
                returnPropertyQuota: true,
            };
            if (args.breakdown) request.funnelBreakdown = { breakdownDimension: { name: args.breakdown }, limit };
            if (args.nextAction) request.funnelNextAction = { nextActionDimension: { name: args.nextAction }, limit };

            const client = await ctx.client();
            const response = await client.runFunnelReport(property.id, request);
            const table = parseReport(response?.funnelTable ?? {});
            const rows: Row[] = table.rows;

            // Overall rows (no breakdown value) give the headline numbers. GA omits steps that no
            // user reached, so every requested step is listed, with 0 when GA returned no row.
            const overall = args.breakdown ? rows.filter((r) => r[args.breakdown!] === 'RESERVED_TOTAL' || r[args.breakdown!] === null) : rows;
            const headline = args.steps.map((step, i) => {
                const label = `${i + 1}. ${step.name}`;
                const row = overall.find((r) => r.funnelStepName === label) ?? overall.find((r) => String(r.funnelStepName).startsWith(`${i + 1}. `));
                return { step: label, active_users: (row?.activeUsers as number | undefined) ?? 0 };
            });
            const first = headline[0].active_users;
            const last = headline[headline.length - 1].active_users;
            // Overall conversion only makes sense for closed funnels (open funnels let users join at any step).
            const conversion = !args.open && first ? last / first : null;

            const trend = args.trended ? parseReport(response?.funnelVisualization ?? {}).rows : undefined;
            return envelope({
                property,
                ranges: [current],
                summary: rows.length
                    ? `${headline.length}-step ${args.open ? 'open' : 'closed'} funnel: ` +
                      `${headline.map((h) => `${h.step} ${fmt(h.active_users, 'int')}`).join(' → ')}` +
                      (args.open ? ' (open funnel: users can join at any step, so later steps can be larger).' : ` (${fmt(conversion, 'pct')} overall).`)
                    : 'No funnel data for this date range.',
                rows,
                format: args.format,
                rowCount: table.rowCount,
                warnings: uniqueWarnings(
                    [ALPHA_WARNING],
                    [...notes],
                    metadataWarnings(response?.funnelTable?.metadata),
                    todayWarning([current], property.timeZone),
                    quotaWarnings(response?.propertyQuota),
                ),
                quota: parseQuota(response?.propertyQuota),
                extra: { steps: headline, ...(trend ? { trend } : {}) },
            });
        },
    );
}
