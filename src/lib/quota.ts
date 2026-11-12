/**
 * GA4 Data API quota readout (from `returnPropertyQuota: true`).
 */

interface QuotaStatus { consumed?: number | null; remaining?: number | null }

export interface QuotaSummary {
    tokens_today_left: number | null;
    tokens_hour_left: number | null;
    project_tokens_hour_left: number | null;
    concurrent_requests_left: number | null;
}

const FIELDS: [keyof QuotaSummary, string][] = [
    ['tokens_today_left', 'tokensPerDay'],
    ['tokens_hour_left', 'tokensPerHour'],
    ['project_tokens_hour_left', 'tokensPerProjectPerHour'],
    ['concurrent_requests_left', 'concurrentRequests'],
];

/** Summarize a propertyQuota object; null when the response had none. */
export function parseQuota(propertyQuota: Record<string, QuotaStatus | null | undefined> | null | undefined): QuotaSummary | null {
    if (!propertyQuota) return null;
    const summary = {} as QuotaSummary;
    for (const [key, field] of FIELDS) {
        const remaining = propertyQuota[field]?.remaining;
        summary[key] = typeof remaining === 'number' ? remaining : null;
    }
    return summary;
}

/** Warnings when a token bucket has less than `threshold` of its capacity left. */
export function quotaWarnings(
    propertyQuota: Record<string, QuotaStatus | null | undefined> | null | undefined,
    threshold = 0.1,
): string[] {
    if (!propertyQuota) return [];
    const labels: Record<string, string> = {
        tokensPerDay: 'daily',
        tokensPerHour: 'hourly',
        tokensPerProjectPerHour: 'hourly (this Google Cloud project)',
    };
    const warnings: string[] = [];
    for (const [field, label] of Object.entries(labels)) {
        const status = propertyQuota[field];
        const consumed = status?.consumed ?? 0;
        const remaining = status?.remaining;
        if (typeof remaining !== 'number') continue;
        const capacity = consumed + remaining;
        if (capacity > 0 && remaining / capacity < threshold) {
            warnings.push(`Only ${remaining} of ${capacity} ${label} GA4 quota tokens left for this property.`);
        }
    }
    return warnings;
}
