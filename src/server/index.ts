/**
 * MCP server setup (stdio). Tools are listed without credentials; Google sign-in is only
 * needed when a tool calls GA4.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION } from '../version.js';
import { ServerContext, type ContextOptions } from './context.js';
import { registerCompareTools } from './tools/compare.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerFunnelTools } from './tools/funnel.js';
import { registerOverviewTools } from './tools/overview.js';
import { registerPageTools } from './tools/pages.js';
import { registerReportTools } from './tools/report.js';

export const SERVER_INSTRUCTIONS = `Google Analytics 4 data, built to be combined with Search Console, AdSense and Ahrefs.
- Start with ga_list_properties to map sites (hosts) to GA4 property ids; any tool's "property" also accepts a host like example.com.
- Page rows carry url_key (lowercase host without www + path, no query/trailing slash). Convert other tools' URLs with ga_normalize_urls, or fetch GA metrics for a URL list with ga_pages_by_url.
- Organic search: ga_landing_pages with organicOnly matches Search Console "page" rows; AdSense PAGE_URL matches ga_top_pages.
- Default dates are the last 28 complete days in the property's time zone. Check "warnings" (thresholding, sampling, partial today) before drawing conclusions.
- ga_run_report is the escape hatch for anything else; use ga_search_fields to find field names.`;

export function createServer(options: ContextOptions = {}): { server: McpServer; ctx: ServerContext } {
    const ctx = new ServerContext(options);
    const server = new McpServer({ name: 'ga-mcp', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
    registerDiscoveryTools(server, ctx);
    registerReportTools(server, ctx);
    registerFunnelTools(server, ctx);
    registerOverviewTools(server, ctx);
    registerPageTools(server, ctx);
    registerCompareTools(server, ctx);
    return { server, ctx };
}

export async function startStdioServer(options: ContextOptions = {}): Promise<void> {
    const { server } = createServer(options);
    await server.connect(new StdioServerTransport());
}
