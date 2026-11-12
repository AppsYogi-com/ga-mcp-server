/**
 * CLI commands (loaded after the Node version check in index.ts).
 */

import { rm } from 'fs/promises';
import { join } from 'path';
import { Command } from 'commander';
import { CONFIG_DIR, deleteConfig, loadConfig } from '../auth/config.js';
import { deleteTokens } from '../auth/tokenStore.js';
import { explainError } from '../ga/errors.js';
import { VERSION } from '../version.js';

export async function main(argv: string[]): Promise<void> {
    const program = new Command();
    program
        .name('ga-mcp')
        .description('Google Analytics 4 MCP server: joinable GA4 data for Claude and other MCP clients')
        .version(VERSION);

    program
        .command('init')
        .description('Sign in with Google (OAuth Desktop client) or set up a service account')
        .option('--client-id <id>', 'OAuth Client ID')
        .option('--client-secret <secret>', 'OAuth Client Secret')
        .option('--reuse-client <server>', 'Reuse the OAuth client of adsense-mcp or gsc-mcp ("adsense" or "gsc")')
        .option('--service-account <path>', 'Use a service account key file instead of OAuth')
        .option('--port <number>', 'Local port for the OAuth redirect (default: random free port)')
        .option('--default <property>', 'Default property (id or site host) to save')
        .action(async (options) => {
            const { runInit } = await import('./init.js');
            await runInit(options);
        });

    program
        .command('doctor')
        .description('Check the setup: config, sign-in, Admin API, Data API and quota')
        .action(async () => {
            const { runDoctor } = await import('./doctor.js');
            await runDoctor();
        });

    program
        .command('run')
        .description('Start the MCP server over stdio (your MCP client runs this)')
        .option('--property <id|host>', 'Default GA4 property (overrides the saved default)')
        .action(async (options: { property?: string }) => {
            const { startStdioServer } = await import('../server/index.js');
            const config = await loadConfig().catch(() => null);
            await startStdioServer({ defaultProperty: options.property ?? config?.defaultProperty });
        });

    program
        .command('properties')
        .description('List GA4 properties and the site hosts they track')
        .action(async () => {
            const { ServerContext } = await import('../server/context.js');
            try {
                const map = await new ServerContext().propertyMap();
                for (const p of map) {
                    console.log(`${p.property_id.padEnd(12)} ${p.name}${p.hosts.length ? `  →  ${p.hosts.join(', ')}` : ''}`);
                }
            } catch (error) {
                console.error(`❌ ${explainError(error)}`);
                process.exitCode = 1;
            }
        });

    program
        .command('logout')
        .description('Remove the saved Google sign-in')
        .option('--all', 'Also remove the config (OAuth client, default property, service account key)')
        .action(async (options: { all?: boolean }) => {
            await deleteTokens();
            if (options.all) {
                await deleteConfig();
                await rm(join(CONFIG_DIR, 'service-account.json'), { force: true });
            }
            console.log(options.all ? '✅ Sign-in and config removed.' : '✅ Sign-in removed. Run `ga-mcp init` to sign in again.');
        });

    await program.parseAsync(argv);
}
