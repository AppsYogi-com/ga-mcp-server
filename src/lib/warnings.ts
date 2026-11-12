/**
 * Data-quality warnings from GA4 response metadata, so agents know when numbers are partial.
 */

import { includesToday, type DateRange } from './dates.js';

export interface ResponseMetadata {
    subjectToThresholding?: boolean | null;
    samplingMetadatas?: { samplesReadCount?: string | number | null; samplingSpaceSize?: string | number | null }[] | null;
    dataLossFromOtherRow?: boolean | null;
    emptyReason?: string | null;
}

export function metadataWarnings(metadata: ResponseMetadata | null | undefined): string[] {
    if (!metadata) return [];
    const warnings: string[] = [];
    if (metadata.subjectToThresholding) {
        warnings.push('GA4 thresholding may hide some rows (small user counts or demographic/Google signals data).');
    }
    for (const s of metadata.samplingMetadatas ?? []) {
        const read = Number(s.samplesReadCount);
        const space = Number(s.samplingSpaceSize);
        if (read > 0 && space > 0) {
            warnings.push(`Sampled data: based on ${Math.round((read / space) * 1000) / 10}% of events.`);
        }
    }
    if (metadata.dataLossFromOtherRow) {
        warnings.push('High-cardinality data: some values were grouped into "(other)". Use a shorter date range or fewer dimensions.');
    }
    if (metadata.emptyReason) warnings.push(`No data: ${metadata.emptyReason}`);
    return warnings;
}

export function todayWarning(ranges: DateRange[], timeZone: string | undefined, now: Date = new Date()): string[] {
    return ranges.some((r) => includesToday(r, timeZone, now))
        ? ['The date range includes today, so the latest numbers are still incomplete.']
        : [];
}

/** De-duplicate warnings while keeping their order. */
export function uniqueWarnings(...lists: string[][]): string[] {
    return [...new Set(lists.flat())];
}
