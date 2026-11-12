/**
 * @appsyogi/ga-mcp-server: programmatic entry points.
 */

export { createServer, startStdioServer, SERVER_INSTRUCTIONS } from './server/index.js';
export { ServerContext, type ContextOptions, type PropertyWithHosts } from './server/context.js';
export type { GaClient, PropertySummary, PropertyDetails, DataStream, FieldMetadata } from './ga/client.js';
export { toUrlKey, normalizeHost } from './lib/urlKey.js';
export { compileFilters, FilterSyntaxError, type FilterExpression } from './lib/filters.js';
export { VERSION } from './version.js';
