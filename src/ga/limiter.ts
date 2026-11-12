/**
 * Request pacing: at most N concurrent requests per property (GA4 allows 10 on standard
 * properties), and retries for transient server errors only. 429 (quota) is never retried,
 * since retrying just burns more quota.
 */

import { errorStatus } from './errors.js';

export class Semaphore {
    private active = 0;
    private readonly queue: (() => void)[] = [];

    constructor(private readonly max: number) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.active >= this.max) {
            await new Promise<void>((resolve) => this.queue.push(resolve));
        }
        this.active++;
        try {
            return await fn();
        } finally {
            this.active--;
            this.queue.shift()?.();
        }
    }
}

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE']);

export function isTransient(error: unknown): boolean {
    const status = errorStatus(error);
    if (status !== undefined) return status >= 500 && status <= 599;
    const code = (error as { code?: unknown })?.code;
    return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry transient failures with exponential backoff (default: 3 attempts, 500ms then 1s). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 500): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (!isTransient(error) || attempt === attempts - 1) throw error;
            await sleep(baseDelayMs * 2 ** attempt);
        }
    }
    throw lastError;
}

/** One semaphore per property id. */
export class PropertyLimiter {
    private readonly semaphores = new Map<string, Semaphore>();

    constructor(private readonly maxPerProperty = 4) {}

    run<T>(propertyId: string, fn: () => Promise<T>): Promise<T> {
        let semaphore = this.semaphores.get(propertyId);
        if (!semaphore) {
            semaphore = new Semaphore(this.maxPerProperty);
            this.semaphores.set(propertyId, semaphore);
        }
        return semaphore.run(() => withRetry(fn));
    }
}
