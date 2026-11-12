/**
 * `ga-mcp init`: sign in with Google (Desktop OAuth client, loopback redirect + PKCE), or set up
 * a service account. Then print the property <-> host map and save a default property.
 */

import { randomBytes } from 'crypto';
import { copyFile, chmod } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { join, resolve } from 'path';
import * as readline from 'readline';
import open from 'open';
import { CodeChallengeMethod, GoogleAuth, OAuth2Client } from 'google-auth-library';
import { CONFIG_DIR, ensureConfigDir, readSiblingClient, saveConfig, SCOPES, type Config } from '../auth/config.js';
import { saveTokens } from '../auth/tokenStore.js';
import { GoogleGaClient } from '../ga/client.js';
import { explainError } from '../ga/errors.js';
import { ServerContext, type PropertyWithHosts } from '../server/context.js';

export interface InitOptions {
    clientId?: string;
    clientSecret?: string;
    reuseClient?: string;
    serviceAccount?: string;
    port?: string;
    default?: string;
}

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

const isClientId = (value: string) => value.endsWith('.apps.googleusercontent.com');

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function prompt(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolvePrompt) => {
        rl.question(question, (answer) => {
            rl.close();
            resolvePrompt(answer.trim());
        });
    });
}

function fail(message: string): never {
    console.error(`\n❌ ${message}`);
    process.exit(1);
}

export async function runInit(options: InitOptions): Promise<void> {
    console.log('🚀 GA4 MCP Server setup\n');
    if (options.serviceAccount) return setupServiceAccount(options);
    return setupOAuth(options);
}

async function setupOAuth(options: InitOptions): Promise<void> {
    let clientId = options.clientId;
    let clientSecret = options.clientSecret;

    if (options.reuseClient) {
        if (options.reuseClient !== 'adsense' && options.reuseClient !== 'gsc') fail('--reuse-client must be "adsense" or "gsc".');
        try {
            const sibling = await readSiblingClient(options.reuseClient);
            clientId = sibling.clientId;
            clientSecret = sibling.clientSecret;
            console.log(`Using the OAuth client from ${sibling.path}`);
            console.log('Make sure the Google Analytics Data API and Admin API are enabled in that Google Cloud project.\n');
        } catch (error) {
            fail((error as Error).message);
        }
    }

    clientId ||= await prompt('OAuth Client ID (ends with .apps.googleusercontent.com): ');
    clientSecret ||= await prompt('OAuth Client Secret (usually starts with GOCSPX-): ');
    if (!clientId || !clientSecret) {
        fail('A Desktop-app OAuth Client ID and Secret are required. Create one at https://console.cloud.google.com/apis/credentials');
    }
    if (!isClientId(clientId) && isClientId(clientSecret)) {
        [clientId, clientSecret] = [clientSecret, clientId];
        console.log('ℹ️  Client ID and Client Secret looked swapped. Using them in the correct order.\n');
    }
    if (!isClientId(clientId)) fail('That does not look like an OAuth Client ID (it should end with .apps.googleusercontent.com).');

    const port = options.port ? Number(options.port) : 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`Invalid --port value: ${options.port}`);

    const oauth2Client = await signIn(clientId, clientSecret, port);
    const config: Config = { authType: 'oauth', clientId, clientSecret };
    await saveConfig(config);
    console.log('\n✅ Signed in. Google sign-in saved.');

    await finishSetup(config, new ServerContext({ clientFactory: async () => new GoogleGaClient(oauth2Client) }), options.default);
}

/** Loopback OAuth flow: local server on 127.0.0.1, PKCE, state check, auto-opened browser. */
async function signIn(clientId: string, clientSecret: string, port: number): Promise<OAuth2Client> {
    const server = http.createServer();
    await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolveListen());
    });
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = randomBytes(16).toString('hex');
    const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
    });

    console.log('📋 Opening your browser to sign in. If it does not open, visit:\n');
    console.log(authUrl);
    console.log(`\n⏳ Waiting for Google to redirect to ${redirectUri} (5 minutes)...`);
    console.log('   ("redirect_uri_mismatch" means your OAuth client isn\'t a "Desktop app" client.)\n');
    open(authUrl)
        .then((child) => child.on('error', () => undefined))
        .catch(() => undefined);

    let timer: NodeJS.Timeout | undefined;
    try {
        const code = await new Promise<string>((resolveCode, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out waiting for sign-in (5 minutes). Run `ga-mcp init` again.')), AUTH_TIMEOUT_MS);
            server.on('request', (req, res) => {
                const url = new URL(req.url ?? '/', 'http://127.0.0.1');
                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');
                if (!code && !error) {
                    res.writeHead(404).end();
                    return;
                }
                const reply = (status: number, title: string) => {
                    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
                    res.end(`<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>${escapeHtml(title)}</h2><p>You can close this tab and return to the terminal.</p></body></html>`);
                };
                if (error) {
                    reply(400, `Sign-in was not completed (${error}).`);
                    reject(new Error(`Google returned an error: ${error}`));
                } else if (url.searchParams.get('state') !== state) {
                    reply(400, 'Sign-in failed: state mismatch.');
                    reject(new Error('State mismatch in the OAuth callback. Please try again.'));
                } else {
                    reply(200, '✅ GA4 MCP is authorized.');
                    resolveCode(code!);
                }
            });
        });

        const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
        if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Run `ga-mcp init` again.');
        client.setCredentials(tokens);
        const storage = await saveTokens({
            accessToken: tokens.access_token ?? undefined,
            refreshToken: tokens.refresh_token,
            expiryDate: tokens.expiry_date ?? undefined,
            obtainedAt: Date.now(),
        });
        console.log(`🔐 Tokens saved to the ${storage === 'keychain' ? 'OS keychain' : `file ${join(CONFIG_DIR, 'tokens.json')} (mode 600)`}.`);
        return client;
    } catch (error) {
        return fail(explainError(error));
    } finally {
        if (timer) clearTimeout(timer);
        server.closeAllConnections();
        server.close();
    }
}

async function setupServiceAccount(options: InitOptions): Promise<void> {
    const keyPath = resolve(options.serviceAccount!);
    if (!existsSync(keyPath)) fail(`Service account key file not found: ${keyPath}`);
    let key: { client_email?: string; private_key?: string };
    try {
        key = JSON.parse(readFileSync(keyPath, 'utf-8'));
    } catch {
        fail(`${keyPath} is not valid JSON.`);
    }
    if (!key.client_email || !key.private_key) fail(`${keyPath} is not a service account key (no client_email/private_key).`);

    await ensureConfigDir();
    const dest = join(CONFIG_DIR, 'service-account.json');
    await copyFile(keyPath, dest);
    await chmod(dest, 0o600);
    const config: Config = { authType: 'service-account', serviceAccountPath: dest };
    await saveConfig(config);
    console.log(`✅ Service account key saved to ${dest} (mode 600).`);
    console.log(`📧 ${key.client_email}`);
    console.log('   Add this email as a Viewer in each GA4 property: Admin → Property access management.\n');

    const auth = new GoogleAuth({ keyFile: dest, scopes: SCOPES });
    const client = await auth.getClient();
    await finishSetup(config, new ServerContext({ clientFactory: async () => new GoogleGaClient(client) }), options.default);
}

function printProperties(map: PropertyWithHosts[]): void {
    if (map.length === 0) {
        console.log('No GA4 properties are visible to this account yet.');
        return;
    }
    console.log(`\n📊 ${map.length} GA4 propert${map.length === 1 ? 'y' : 'ies'}:`);
    for (const p of map) {
        console.log(`   ${p.property_id.padEnd(12)} ${p.name}${p.hosts.length ? `  →  ${p.hosts.join(', ')}` : ''}`);
    }
}

/** List properties, then save a default property (flag, single property, or prompt). */
async function finishSetup(config: Config, ctx: ServerContext, requestedDefault?: string): Promise<void> {
    let map: PropertyWithHosts[] = [];
    try {
        map = await ctx.propertyMap();
        printProperties(map);
    } catch (error) {
        console.log(`\n⚠️  Signed in, but listing properties failed: ${explainError(error)}`);
        console.log('   Fix that, then run `ga-mcp doctor`.');
        return;
    }

    let choice = requestedDefault;
    if (!choice && map.length === 1) choice = map[0].property_id;
    if (!choice && map.length > 1 && process.stdin.isTTY) {
        choice = await prompt('\nDefault property for MCP clients (id or site host; Enter to skip): ');
    }
    if (choice) {
        try {
            const property = await ctx.property(choice);
            await saveConfig({ ...config, defaultProperty: property.id });
            console.log(`⭐ Default property: ${property.id} (${property.displayName})`);
        } catch (error) {
            console.log(`⚠️  Couldn't set the default property: ${explainError(error)}`);
        }
    }
    console.log('\nNext: run `ga-mcp doctor` to check everything, and add the server to your MCP client.');
}
