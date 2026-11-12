/**
 * OAuth token storage: the OS keychain (via @napi-rs/keyring, prebuilt, no install scripts),
 * falling back to tokens.json with mode 0600. Set GA_MCP_TOKEN_STORE=file to skip the keychain.
 */

import { existsSync, statSync } from 'fs';
import { readFile, rm } from 'fs/promises';
import { TOKENS_PATH, writePrivateFile } from './config.js';

const SERVICE = 'ga-mcp';
const ACCOUNT = 'tokens';

export interface StoredTokens {
    accessToken?: string;
    refreshToken: string;
    expiryDate?: number;
    /** When the refresh token was obtained (ms since epoch), for Testing-mode expiry hints. */
    obtainedAt: number;
}

export type TokenStorage = 'keychain' | 'file';

interface KeyringEntry {
    getPassword(): string | null;
    setPassword(password: string): void;
    deletePassword(): boolean;
}

async function keyringEntry(): Promise<KeyringEntry | null> {
    if (process.env.GA_MCP_TOKEN_STORE === 'file') return null;
    try {
        const { Entry } = await import('@napi-rs/keyring');
        return new Entry(SERVICE, ACCOUNT) as KeyringEntry;
    } catch {
        return null;
    }
}

export async function loadTokens(): Promise<{ tokens: StoredTokens; storage: TokenStorage } | null> {
    const entry = await keyringEntry();
    if (entry) {
        try {
            const value = entry.getPassword();
            if (value) return { tokens: JSON.parse(value) as StoredTokens, storage: 'keychain' };
        } catch {
            // Keychain unavailable or locked: try the file.
        }
    }
    if (existsSync(TOKENS_PATH)) {
        return { tokens: JSON.parse(await readFile(TOKENS_PATH, 'utf-8')) as StoredTokens, storage: 'file' };
    }
    return null;
}

/** Save tokens to the keychain, or to tokens.json (0600) when the keychain isn't available. */
export async function saveTokens(tokens: StoredTokens): Promise<TokenStorage> {
    const json = JSON.stringify(tokens);
    const entry = await keyringEntry();
    if (entry) {
        try {
            entry.setPassword(json);
            await rm(TOKENS_PATH, { force: true }); // don't leave an older copy on disk
            return 'keychain';
        } catch {
            // fall through to the file store
        }
    }
    await writePrivateFile(TOKENS_PATH, json);
    return 'file';
}

export async function deleteTokens(): Promise<void> {
    const entry = await keyringEntry();
    try {
        entry?.deletePassword();
    } catch {
        // nothing stored
    }
    await rm(TOKENS_PATH, { force: true });
}

/** File mode of tokens.json as an octal string (e.g. "600"), or null when there is no file. */
export function tokenFileMode(): string | null {
    if (!existsSync(TOKENS_PATH)) return null;
    return (statSync(TOKENS_PATH).mode & 0o777).toString(8);
}
