#!/usr/bin/env node
/**
 * ga-mcp CLI entry point. Checks the Node.js version before loading anything else, so older
 * Node versions get a clear message instead of a syntax error.
 */

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
    process.stderr.write(
        `ga-mcp needs Node.js 22.12 or newer (this is ${process.version} at ${process.execPath}).\n` +
            'In MCP client configs, use the full path to a newer node binary as the "command".\n',
    );
    process.exit(1);
}

const { main } = await import('./main.js');
await main(process.argv);
