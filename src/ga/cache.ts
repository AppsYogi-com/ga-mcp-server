/**
 * Small in-memory TTL cache (per server process). Property lists and metadata change rarely;
 * report results are cached briefly so agents re-reading the same report don't spend quota.
 */

export const TTL = {
    properties: 60 * 60 * 1000,
    metadata: 24 * 60 * 60 * 1000,
    report: 5 * 60 * 1000,
} as const;

export class TtlCache {
    private readonly entries = new Map<string, { value: unknown; expires: number }>();

    constructor(private readonly maxEntries = 500) {}

    get<T>(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expires < Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value as T;
    }

    set<T>(key: string, value: T, ttlMs: number): T {
        if (this.entries.size >= this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) this.entries.delete(oldest);
        }
        this.entries.set(key, { value, expires: Date.now() + ttlMs });
        return value;
    }

    /** Return the cached value, or compute and cache it. Failures aren't cached. */
    async getOrSet<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
        const hit = this.get<T>(key);
        if (hit !== undefined) return hit;
        return this.set(key, await compute(), ttlMs);
    }
}
