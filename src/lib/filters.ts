/**
 * Friendly filter syntax -> GA4 Data API FilterExpression.
 *
 *   filters: ["sessionDefaultChannelGroup==Organic Search", "pagePath=@/blog||pagePath=@/guides", "sessions>100"]
 *
 * - Entries are ANDed; `||` inside an entry means OR.
 * - Dimension operators: == != =@ (contains) !@ =^ (begins with) =$ (ends with) =~ (regex) !~  and  dim=[a,b,c] (in list)
 * - Metric operators: > < >= <= == !=   (metric filters apply after aggregation, like SQL HAVING)
 * - String matching is case-insensitive.
 * - Escapes: \| for a literal pipe, \, for a literal comma inside [lists], \\ for a backslash.
 *   Other backslashes are kept as-is (so regexes like \d work).
 */

import type { FieldKind } from './fields.js';

export interface StringFilter { matchType: string; value: string; caseSensitive: boolean }
export interface InListFilter { values: string[]; caseSensitive: boolean }
export interface NumericFilter { operation: string; value: { int64Value?: string; doubleValue?: number } }
export interface Filter {
    fieldName: string;
    stringFilter?: StringFilter;
    inListFilter?: InListFilter;
    numericFilter?: NumericFilter;
}
export interface FilterExpression {
    andGroup?: { expressions: FilterExpression[] };
    orGroup?: { expressions: FilterExpression[] };
    notExpression?: FilterExpression;
    filter?: Filter;
}

export interface CompiledFilters {
    dimensionFilter?: FilterExpression;
    metricFilter?: FilterExpression;
}

export class FilterSyntaxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FilterSyntaxError';
    }
}

/** Resolves a field name to its kind; returns undefined when the field is unknown. */
export type FieldKindResolver = (name: string) => FieldKind | undefined;

const CONDITION = /^\s*([A-Za-z][A-Za-z0-9_]*(?::[A-Za-z0-9_.-]+)?)\s*(==|!=|=@|!@|=\^|=\$|=~|!~|>=|<=|>|<|=)\s*([\s\S]*?)\s*$/;

const STRING_OPS: Record<string, { matchType: string; negate: boolean }> = {
    '==': { matchType: 'EXACT', negate: false },
    '!=': { matchType: 'EXACT', negate: true },
    '=@': { matchType: 'CONTAINS', negate: false },
    '!@': { matchType: 'CONTAINS', negate: true },
    '=^': { matchType: 'BEGINS_WITH', negate: false },
    '=$': { matchType: 'ENDS_WITH', negate: false },
    '=~': { matchType: 'PARTIAL_REGEXP', negate: false },
    '!~': { matchType: 'PARTIAL_REGEXP', negate: true },
};

const NUMERIC_OPS: Record<string, { operation: string; negate: boolean }> = {
    '==': { operation: 'EQUAL', negate: false },
    '!=': { operation: 'EQUAL', negate: true },
    '>': { operation: 'GREATER_THAN', negate: false },
    '>=': { operation: 'GREATER_THAN_OR_EQUAL', negate: false },
    '<': { operation: 'LESS_THAN', negate: false },
    '<=': { operation: 'LESS_THAN_OR_EQUAL', negate: false },
};

/** Split on a separator, ignoring escaped occurrences (\| or \,). */
function splitUnescaped(input: string, separator: string): string[] {
    const parts: string[] = [];
    let current = '';
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === '\\' && i + 1 < input.length) {
            current += ch + input[i + 1];
            i++;
            continue;
        }
        if (input.startsWith(separator, i)) {
            parts.push(current);
            current = '';
            i += separator.length - 1;
            continue;
        }
        current += ch;
    }
    parts.push(current);
    return parts;
}

/** Remove the escape backslash before |, comma and backslash; keep all other backslashes. */
function unescape(value: string): string {
    return value.replace(/\\([|,\\])/g, '$1');
}

function numericValue(raw: string, field: string): NumericFilter['value'] {
    const text = raw.trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
        throw new FilterSyntaxError(`"${field}" is a metric, so its value must be a number (got "${raw}").`);
    }
    return /^-?\d+$/.test(text) ? { int64Value: text } : { doubleValue: Number(text) };
}

interface Condition { kind: FieldKind; expression: FilterExpression }

function compileCondition(text: string, resolveKind: FieldKindResolver): Condition {
    const match = CONDITION.exec(text);
    if (!match) {
        throw new FilterSyntaxError(
            `Can't parse filter "${text}". Use field, operator and value, e.g. "pagePath=@/blog" or "sessions>100".`,
        );
    }
    const [, field, op, rawValue] = match;
    const kind = resolveKind(field);
    if (!kind) {
        throw new FilterSyntaxError(`Unknown field "${field}". Use ga_search_fields to find valid dimension and metric names.`);
    }

    if (kind === 'metric') {
        const numeric = NUMERIC_OPS[op];
        if (!numeric) {
            throw new FilterSyntaxError(`"${field}" is a metric; use one of > < >= <= == != (got "${op}").`);
        }
        const filter: Filter = { fieldName: field, numericFilter: { operation: numeric.operation, value: numericValue(rawValue, field) } };
        return { kind, expression: numeric.negate ? { notExpression: { filter } } : { filter } };
    }

    if (op === '=') {
        const list = rawValue.trim();
        if (!(list.startsWith('[') && list.endsWith(']'))) {
            throw new FilterSyntaxError(`Use == for an exact match or ${field}=[a,b] for a list (got "${text}").`);
        }
        const values = splitUnescaped(list.slice(1, -1), ',').map((v) => unescape(v.trim())).filter((v) => v.length > 0);
        if (values.length === 0) throw new FilterSyntaxError(`The list in "${text}" is empty.`);
        return { kind, expression: { filter: { fieldName: field, inListFilter: { values, caseSensitive: false } } } };
    }

    const stringOp = STRING_OPS[op];
    if (!stringOp) {
        throw new FilterSyntaxError(`"${field}" is a dimension; use == != =@ !@ =^ =$ =~ !~ or =[a,b] (got "${op}").`);
    }
    const filter: Filter = {
        fieldName: field,
        stringFilter: { matchType: stringOp.matchType, value: unescape(rawValue), caseSensitive: false },
    };
    return { kind, expression: stringOp.negate ? { notExpression: { filter } } : { filter } };
}

function combine(expressions: FilterExpression[], group: 'andGroup' | 'orGroup'): FilterExpression | undefined {
    if (expressions.length === 0) return undefined;
    if (expressions.length === 1) return expressions[0];
    return { [group]: { expressions } } as FilterExpression;
}

/** Compile friendly filter strings into dimension and metric FilterExpressions. */
export function compileFilters(entries: string[] | undefined, resolveKind: FieldKindResolver): CompiledFilters {
    const dimension: FilterExpression[] = [];
    const metric: FilterExpression[] = [];
    for (const entry of entries ?? []) {
        if (!entry || !entry.trim()) continue;
        const alternatives = splitUnescaped(entry, '||').map((part) => compileCondition(part, resolveKind));
        const kinds = new Set(alternatives.map((a) => a.kind));
        if (kinds.size > 1) {
            throw new FilterSyntaxError(
                `"${entry}" mixes dimensions and metrics in one OR group, which GA4 doesn't support. Split it into separate filters.`,
            );
        }
        const expression = combine(alternatives.map((a) => a.expression), 'orGroup')!;
        (alternatives[0].kind === 'metric' ? metric : dimension).push(expression);
    }
    return {
        dimensionFilter: combine(dimension, 'andGroup'),
        metricFilter: combine(metric, 'andGroup'),
    };
}

/** AND together any number of optional expressions. */
export function andExpressions(...expressions: (FilterExpression | undefined)[]): FilterExpression | undefined {
    const present = expressions.filter((e): e is FilterExpression => !!e);
    return combine(present, 'andGroup');
}

/** Exact-match in-list filter on one dimension. */
export function inListExpression(fieldName: string, values: string[], caseSensitive = true): FilterExpression {
    return { filter: { fieldName, inListFilter: { values, caseSensitive } } };
}

/**
 * Convert a FilterExpression into a funnel filter expression (funnel steps use
 * `funnelFieldFilter` instead of `filter`).
 */
export function toFunnelFilterExpression(expression: FilterExpression): Record<string, unknown> {
    if (expression.filter) return { funnelFieldFilter: expression.filter };
    if (expression.notExpression) return { notExpression: toFunnelFilterExpression(expression.notExpression) };
    if (expression.andGroup) return { andGroup: { expressions: expression.andGroup.expressions.map(toFunnelFilterExpression) } };
    if (expression.orGroup) return { orGroup: { expressions: expression.orGroup.expressions.map(toFunnelFilterExpression) } };
    return {};
}
