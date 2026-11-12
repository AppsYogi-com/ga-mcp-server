/**
 * Merge report rows that share a key (e.g. "/blog" and "/blog/" both map to one url_key).
 * Only additive metrics are summed; callers recompute ratios from the sums.
 */

import { ADDITIVE_METRICS, APPROXIMATE_WHEN_SUMMED } from './fields.js';
import type { Row } from './format.js';

export interface MergeResult {
    rows: Row[];
    /** True when user counts were summed across rows, so they may double-count users. */
    approximateUsers: boolean;
}

export function mergeRows(rows: Row[], keyOf: (row: Row) => string | null, metrics: string[], keepColumns: string[] = []): MergeResult {
    const merged = new Map<string, Row>();
    const counts = new Map<string, number>();
    let approximateUsers = false;
    const summable = metrics.filter((m) => ADDITIVE_METRICS.has(m) || APPROXIMATE_WHEN_SUMMED.has(m));

    for (const row of rows) {
        const key = keyOf(row);
        if (key === null) continue;
        const existing = merged.get(key);
        if (!existing) {
            const first: Row = {};
            for (const c of keepColumns) first[c] = row[c] ?? null;
            for (const m of summable) first[m] = (row[m] as number | null) ?? 0;
            merged.set(key, first);
            counts.set(key, 1);
            continue;
        }
        for (const m of summable) existing[m] = ((existing[m] as number) ?? 0) + ((row[m] as number | null) ?? 0);
        counts.set(key, (counts.get(key) ?? 1) + 1);
        if (summable.some((m) => APPROXIMATE_WHEN_SUMMED.has(m))) approximateUsers = true;
    }
    return { rows: [...merged.values()], approximateUsers };
}
