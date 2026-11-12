/**
 * `ga-mcp doctor`: check Node, config, tokens, the Admin API and the Data API (separately),
 * show quota, and print a ready-to-paste Claude Desktop config.
 */

import { existsSync, realpathSync, statSync } from 'fs';
import { CONFIG_PATH, loadConfig } from '../auth/config.js';
import { createAuthClient } from '../auth/oauth.js';
import { loadTokens, tokenFileMode } from '../auth/tokenStore.js';
import { GoogleGaClient } from '../ga/client.js';
import { explainError } from '../ga/errors.js';
import { parseQuota } from '../lib/quota.js';
import { ServerContext } from '../server/context.js';

type Status = 'pass' | 'warn' | 'fail';
interface Check { name: string; status: Status; message: string }

const ICON: Record<Status, string> = { pass: '✅', warn: '⚠️ ', fail: '❌' };
const DAY = 24 * 60 * 60 * 1000;

export async function runDoctor(): Promise<void> {
    console.log('🩺 GA4 MCP Server health check\n');
    const checks: Check[] = [];
    const add = (name: string, status: Status, message: string) => checks.push({ name, status, message });

    add('Node.js', 'pass', `${process.version} (${process.execPath})`);

    const config = await loadConfig().catch((error) => {
        add('Config', 'fail', (error as Error).message);
        return null;
    });
    if (!config) {
        if (!checks.some((c) => c.name === 'Config')) add('Config', 'fail', `Not found at ${CONFIG_PATH}. Run \`ga-mcp init\`.`);
        return report(checks);
    }
    const mode = (statSync(CONFIG_PATH).mode & 0o777).toString(8);
    add('Config', mode === '600' ? 'pass' : 'warn', `${config.authType === 'oauth' ? 'OAuth' : 'Service account'} (${CONFIG_PATH}, mode ${mode})`);

    if (config.authType === 'oauth') {
        const stored = await loadTokens();
        if (!stored) {
            add('Sign-in', 'fail', 'No saved Google sign-in. Run `ga-mcp init`.');
            return report(checks);
        }
        const where = stored.storage === 'keychain' ? 'OS keychain' : `tokens.json (mode ${tokenFileMode()})`;
        const age = Math.floor((Date.now() - (stored.tokens.obtainedAt ?? Date.now())) / DAY);
        add('Sign-in', 'pass', `Saved in ${where}, signed in ${age} day${age === 1 ? '' : 's'} ago`);
    } else if (!config.serviceAccountPath || !existsSync(config.serviceAccountPath)) {
        add('Service account', 'fail', 'Key file missing. Run `ga-mcp init --service-account <key.json>`.');
        return report(checks);
    }

    let ctx: ServerContext;
    try {
        const client = new GoogleGaClient(await createAuthClient(config));
        ctx = new ServerContext({ clientFactory: async () => client, defaultProperty: config.defaultProperty });
    } catch (error) {
        add('Auth client', 'fail', explainError(error));
        return report(checks);
    }

    let propertyId = config.defaultProperty;
    try {
        const map = await ctx.propertyMap();
        add('Admin API', map.length > 0 ? 'pass' : 'warn', `${map.length} GA4 propert${map.length === 1 ? 'y' : 'ies'} visible`);
        propertyId ??= map[0]?.property_id;
    } catch (error) {
        add('Admin API', 'fail', explainError(error));
    }

    if (propertyId) {
        try {
            const client = await ctx.client();
            const response = await client.runReport(propertyId, {
                dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
                metrics: [{ name: 'sessions' }],
                limit: 1,
                returnPropertyQuota: true,
            });
            const q = parseQuota(response.propertyQuota);
            const quota = q
                ? `quota left: ${q.tokens_today_left} today, ${q.tokens_hour_left} this hour, ${q.project_tokens_hour_left} this hour for this project`
                : 'quota not reported';
            add('Data API', 'pass', `Report OK on property ${propertyId}; ${quota}`);
        } catch (error) {
            add('Data API', 'fail', explainError(error));
        }
    }

    if (config.defaultProperty) add('Default property', 'pass', config.defaultProperty);
    else add('Default property', 'warn', 'None. Tools will need a `property` argument, or use `ga-mcp run --property <id|host>`.');

    report(checks, config.defaultProperty);
}

function report(checks: Check[], defaultProperty?: string): void {
    console.log('📋 Results:\n');
    for (const c of checks) console.log(`${ICON[c.status]} ${c.name}: ${c.message}`);
    console.log('');
    if (checks.some((c) => c.status === 'fail')) {
        console.log('❌ Some checks failed. Fix the issues above.\n');
        process.exitCode = 1;
        return;
    }
    console.log('✅ All checks passed.\n');
    let script = process.argv[1];
    try {
        script = realpathSync(script);
    } catch {
        // keep argv[1]
    }
    const args = [script, 'run', ...(defaultProperty ? ['--property', defaultProperty] : [])];
    console.log('Claude Desktop config (quit Claude Desktop with ⌘Q before editing its config):\n');
    console.log(JSON.stringify({ mcpServers: { ga: { command: process.execPath, args } } }, null, 2));
    console.log('\nClaude Code:\n');
    console.log(`claude mcp add ga -- ga-mcp run${defaultProperty ? ` --property ${defaultProperty}` : ''}\n`);
}
