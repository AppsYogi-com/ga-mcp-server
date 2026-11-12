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

const stepSchema = z.object({
    name: z.string().min(1).describe('Step label, e.g. "Viewed pricing".'),
    event: z.string().optional().describe('Event that completes the step, e.g. "page_view", "sign_up", "purchase".'),
    filters: z
        .array(z.string())
        .optional()
        .describe('Dimension conditions for the step, same syntax as other tools (e.g. "pagePath=^/pricing"). ANDed with `event`.'),
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
            const kindOf = await ctx.kindResolver(property.id, args.steps.flatMap((s) => filterFieldNames(s.filters)));

            const steps = args.steps.map((step) => {
                if (!step.event && !step.filters?.length) {
                    throw new UserInputError(`Funnel step "${step.name}" needs an event and/or filters.`);
                }
                const compiled = compileFilters(step.filters, kindOf);
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

            // Overall rows (no breakdown value) give the headline numbers.
            const overall = args.breakdown ? rows.filter((r) => r[args.breakdown!] === 'RESERVED_TOTAL' || r[args.breakdown!] === null) : rows;
            const headline = (overall.length ? overall : rows).filter((r, i, all) => all.findIndex((x) => x.funnelStepName === r.funnelStepName) === i);
            const first = headline[0]?.activeUsers as number | undefined;
            const last = headline[headline.length - 1]?.activeUsers as number | undefined;
            const conversion = first ? (last ?? 0) / first : null;

            const trend = args.trended ? parseReport(response?.funnelVisualization ?? {}).rows : undefined;
            return envelope({
                property,
                ranges: [current],
                summary: headline.length
                    ? `${headline.length}-step ${args.open ? 'open' : 'closed'} funnel: ${fmt(first ?? null, 'int')} users at "${headline[0].funnelStepName}", ` +
                      `${fmt(last ?? null, 'int')} at "${headline[headline.length - 1].funnelStepName}" (${fmt(conversion, 'pct')} overall).`
                    : 'No funnel data for this date range.',
                rows,
                format: args.format,
                rowCount: table.rowCount,
                warnings: uniqueWarnings(
                    [ALPHA_WARNING],
                    metadataWarnings(response?.funnelTable?.metadata),
                    todayWarning([current], property.timeZone),
                    quotaWarnings(response?.propertyQuota),
                ),
                quota: parseQuota(response?.propertyQuota),
                extra: trend ? { trend } : undefined,
            });
        },
    );
}
