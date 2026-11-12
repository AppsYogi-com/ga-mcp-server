/**
 * ga-mcp configuration: one folder per OS (macOS: ~/Library/Preferences/ga-mcp/).
 * config.json holds the OAuth client secret, so it's written with mode 0600.
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import envPaths from 'env-paths';
import { z } from 'zod';

const paths = envPaths('ga-mcp', { suffix: '' });

export const CONFIG_DIR = paths.config;
export const CONFIG_PATH = join(paths.config, 'config.json');
export const TOKENS_PATH = join(paths.config, 'tokens.json');

export const SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];

export const ConfigSchema = z.object({
    authType: z.enum(['oauth', 'service-account']),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    serviceAccountPath: z.string().optional(),
    defaultProperty: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export class NotConfiguredError extends Error {
    constructor(message = 'ga-mcp is not set up yet. Run `ga-mcp init` in a terminal to sign in with Google.') {
        super(message);
        this.name = 'NotConfiguredError';
    }
}

export async function ensureConfigDir(): Promise<void> {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

/** Write a file readable only by the current user (also fixes the mode of an existing file). */
export async function writePrivateFile(path: string, content: string): Promise<void> {
    await ensureConfigDir();
    await writeFile(path, content, { mode: 0o600 });
    await chmod(path, 0o600);
}

export async function loadConfig(): Promise<Config | null> {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`${CONFIG_PATH} is not valid. Run \`ga-mcp init\` again.`);
    }
    return parsed.data;
}

export async function saveConfig(config: Config): Promise<void> {
    await writePrivateFile(CONFIG_PATH, JSON.stringify(ConfigSchema.parse(config), null, 2));
}

export async function deleteConfig(): Promise<void> {
    await rm(CONFIG_PATH, { force: true });
}

/**
 * Read the OAuth client of another AppsYogi MCP server, so `ga-mcp init --reuse-client`
 * doesn't need the Client ID and Secret pasted again.
 */
export async function readSiblingClient(server: 'adsense' | 'gsc'): Promise<{ clientId: string; clientSecret: string; path: string }> {
    const dir = server === 'adsense'
        ? envPaths('adsense-mcp').config // adsense-mcp uses env-paths' default "-nodejs" suffix
        : envPaths('gsc-mcp', { suffix: '' }).config;
    const path = join(dir, 'config.json');
    if (!existsSync(path)) {
        throw new Error(`No ${server}-mcp config found at ${path}. Run \`${server}-mcp init\` first, or pass --client-id/--client-secret.`);
    }
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    if (typeof raw.clientId !== 'string' || typeof raw.clientSecret !== 'string') {
        throw new Error(`${path} has no OAuth client (it may use a service account).`);
    }
    return { clientId: raw.clientId, clientSecret: raw.clientSecret, path };
}
