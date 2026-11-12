/**
 * Turn Google API and input errors into short, actionable messages for agents and the CLI.
 */

import { NotConfiguredError } from '../auth/config.js';
import { DateInputError } from '../lib/dates.js';
import { FilterSyntaxError } from '../lib/filters.js';

export class UserInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UserInputError';
    }
}

interface GoogleishError {
    message?: string;
    code?: number | string;
    status?: number;
    response?: { status?: number; data?: any };
}

/** HTTP status of a Google API error, if any. */
export function errorStatus(error: unknown): number | undefined {
    const e = error as GoogleishError;
    const status = e?.response?.status ?? e?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
    return typeof status === 'number' ? status : undefined;
}

/** The most specific message Google sent. */
export function googleMessage(error: unknown): string {
    const e = error as GoogleishError;
    const data = e?.response?.data;
    return (
        data?.error?.message ??
        (typeof data?.error === 'string' ? `${data.error}${data.error_description ? `: ${data.error_description}` : ''}` : undefined) ??
        e?.message ??
        String(error)
    );
}

/** Explain an error in one or two sentences, with a fix where we know one. */
export function explainError(error: unknown): string {
    if (
        error instanceof NotConfiguredError ||
        error instanceof FilterSyntaxError ||
        error instanceof DateInputError ||
        error instanceof UserInputError
    ) {
        return error.message;
    }

    const status = errorStatus(error);
    const message = googleMessage(error);

    if (/invalid_grant/i.test(message)) {
        return 'Your Google sign-in has expired or was revoked (OAuth apps in "Testing" mode expire sign-ins after 7 days). Run `ga-mcp init` again.';
    }
    if (/invalid_client|unauthorized_client/i.test(message)) {
        return 'Google rejected the OAuth client (wrong Client ID/Secret, or the client was deleted). Run `ga-mcp init` again.';
    }
    if (/has not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(message)) {
        const link = /https:\/\/console\.(?:developers|cloud)\.google\.com\/\S+/.exec(message)?.[0]?.replace(/[.,)]+$/, '');
        const api = /analyticsadmin/i.test(message) ? 'Google Analytics Admin API' : 'Google Analytics Data API';
        return `The ${api} isn't enabled in your Google Cloud project.${link ? ` Enable it here, wait a minute, and retry: ${link}` : ''}`;
    }
    if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message)) {
        return `GA4 quota exhausted for this property (${message}). Hourly quotas refill within the hour; daily quotas reset at midnight Pacific time. Use shorter date ranges or fewer requests.`;
    }
    if (status === 403 || /PERMISSION_DENIED|sufficient permissions/i.test(message)) {
        return `Your Google account can't access this GA4 property (${message}). Check the property id with ga_list_properties, or ask for Viewer access.`;
    }
    if (status === 404) {
        return `Not found: ${message}. Check the property id with ga_list_properties.`;
    }
    if (status === 400 || /INVALID_ARGUMENT/i.test(message)) {
        const hint = /dimension|metric|field|compatib/i.test(message)
            ? ' Use ga_search_fields to find valid field names and compatible combinations.'
            : '';
        return `GA4 rejected the request: ${message}.${hint}`;
    }
    return message;
}
