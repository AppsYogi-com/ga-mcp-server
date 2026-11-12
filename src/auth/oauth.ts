/**
 * Build an authenticated Google client from the saved config: OAuth (Desktop client + refresh
 * token) or a service account added as a Viewer on the GA4 properties.
 */

import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { loadConfig, NotConfiguredError, SCOPES, type Config } from './config.js';
import { loadTokens, saveTokens } from './tokenStore.js';

export type AuthClient = OAuth2Client | Awaited<ReturnType<GoogleAuth['getClient']>>;

export async function createAuthClient(config?: Config | null): Promise<AuthClient> {
    const cfg = config ?? (await loadConfig());
    if (!cfg) throw new NotConfiguredError();

    if (cfg.authType === 'service-account') {
        if (!cfg.serviceAccountPath) throw new NotConfiguredError('Service account key path is missing. Run `ga-mcp init --service-account <key.json>`.');
        const auth = new GoogleAuth({ keyFile: cfg.serviceAccountPath, scopes: SCOPES });
        return auth.getClient();
    }

    if (!cfg.clientId || !cfg.clientSecret) throw new NotConfiguredError();
    const stored = await loadTokens();
    if (!stored?.tokens.refreshToken) {
        throw new NotConfiguredError('No saved Google sign-in. Run `ga-mcp init` in a terminal.');
    }

    const client = new OAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret });
    client.setCredentials({
        access_token: stored.tokens.accessToken,
        refresh_token: stored.tokens.refreshToken,
        expiry_date: stored.tokens.expiryDate,
    });
    // Persist refreshed access tokens (and a rotated refresh token, if Google sends one).
    client.on('tokens', (t) => {
        void saveTokens({
            accessToken: t.access_token ?? undefined,
            refreshToken: t.refresh_token ?? stored.tokens.refreshToken,
            expiryDate: t.expiry_date ?? undefined,
            obtainedAt: t.refresh_token ? Date.now() : stored.tokens.obtainedAt,
        }).catch(() => undefined);
    });
    return client;
}
