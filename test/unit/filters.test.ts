import { describe, expect, it } from 'vitest';
import { staticFieldKind } from '../../src/lib/fields.js';
import { andExpressions, compileFilters, FilterSyntaxError, inListExpression, toFunnelFilterExpression } from '../../src/lib/filters.js';

const kinds = (name: string) => staticFieldKind(name) ?? (name === 'customEvent:plan' ? 'dimension' : undefined);

describe('compileFilters: dimension operators', () => {
    it.each([
        ['pagePath==/a', { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'EXACT', value: '/a', caseSensitive: false } } }],
        ['pagePath=@/blog', { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: '/blog', caseSensitive: false } } }],
        ['pagePath=^/docs', { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/docs', caseSensitive: false } } }],
        ['pagePath=$.pdf', { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'ENDS_WITH', value: '.pdf', caseSensitive: false } } }],
        ['pagePath=~^/p/\\d+$', { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'PARTIAL_REGEXP', value: '^/p/\\d+$', caseSensitive: false } } }],
        ['country!=India', { notExpression: { filter: { fieldName: 'country', stringFilter: { matchType: 'EXACT', value: 'India', caseSensitive: false } } } }],
        ['pagePath!@/admin', { notExpression: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: '/admin', caseSensitive: false } } } }],
        ['pagePath!~test', { notExpression: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'PARTIAL_REGEXP', value: 'test', caseSensitive: false } } } }],
        ['deviceCategory=[mobile, tablet]', { filter: { fieldName: 'deviceCategory', inListFilter: { values: ['mobile', 'tablet'], caseSensitive: false } } }],
        ['customEvent:plan==pro', { filter: { fieldName: 'customEvent:plan', stringFilter: { matchType: 'EXACT', value: 'pro', caseSensitive: false } } }],
    ])('%s', (entry, expected) => {
        expect(compileFilters([entry], kinds)).toEqual({ dimensionFilter: expected, metricFilter: undefined });
    });

    it('keeps values with spaces and operators inside', () => {
        const { dimensionFilter } = compileFilters(['sessionDefaultChannelGroup==Organic Search'], kinds);
        expect(dimensionFilter?.filter?.stringFilter?.value).toBe('Organic Search');
        const eq = compileFilters(['pagePath==/a=b'], kinds);
        expect(eq.dimensionFilter?.filter?.stringFilter?.value).toBe('/a=b');
    });

    it('handles escapes in values and lists', () => {
        expect(compileFilters(['pageTitle==A \\|\\| B'], kinds).dimensionFilter?.filter?.stringFilter?.value).toBe('A || B');
        expect(compileFilters(['country=[a\\,b, c]'], kinds).dimensionFilter?.filter?.inListFilter?.values).toEqual(['a,b', 'c']);
    });
});

describe('compileFilters: metric operators', () => {
    it.each([
        ['sessions>100', 'GREATER_THAN', { int64Value: '100' }, false],
        ['sessions>=100', 'GREATER_THAN_OR_EQUAL', { int64Value: '100' }, false],
        ['sessions<5', 'LESS_THAN', { int64Value: '5' }, false],
        ['sessions<=5', 'LESS_THAN_OR_EQUAL', { int64Value: '5' }, false],
        ['engagementRate==0.5', 'EQUAL', { doubleValue: 0.5 }, false],
        ['keyEvents!=0', 'EQUAL', { int64Value: '0' }, true],
    ])('%s', (entry, operation, value, negated) => {
        const filter = { fieldName: entry.match(/^[a-zA-Z]+/)![0], numericFilter: { operation, value } };
        expect(compileFilters([entry], kinds)).toEqual({
            dimensionFilter: undefined,
            metricFilter: negated ? { notExpression: { filter } } : { filter },
        });
    });
});

describe('compileFilters: grouping', () => {
    it('ANDs entries and ORs alternatives, routing by kind', () => {
        const result = compileFilters(['pagePath=@/blog||pagePath=@/guides', 'country==India', 'sessions>10'], kinds);
        expect(result.dimensionFilter).toEqual({
            andGroup: {
                expressions: [
                    {
                        orGroup: {
                            expressions: [
                                { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: '/blog', caseSensitive: false } } },
                                { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: '/guides', caseSensitive: false } } },
                            ],
                        },
                    },
                    { filter: { fieldName: 'country', stringFilter: { matchType: 'EXACT', value: 'India', caseSensitive: false } } },
                ],
            },
        });
        expect(result.metricFilter).toEqual({ filter: { fieldName: 'sessions', numericFilter: { operation: 'GREATER_THAN', value: { int64Value: '10' } } } });
    });

    it('returns no filters for empty input', () => {
        expect(compileFilters(undefined, kinds)).toEqual({ dimensionFilter: undefined, metricFilter: undefined });
        expect(compileFilters(['', '  '], kinds)).toEqual({ dimensionFilter: undefined, metricFilter: undefined });
    });
});

describe('compileFilters: errors', () => {
    it.each([
        ['pagePath=/a', /Use == for an exact match/],
        ['nonsense', /Can't parse filter/],
        ['madeUpField==x', /Unknown field "madeUpField"/],
        ['sessions=@1', /is a metric/],
        ['sessions>abc', /must be a number/],
        ['pagePath>3', /is a dimension/],
        ['pagePath=@/a||sessions>3', /mixes dimensions and metrics/],
        ['country=[ ]', /is empty/],
    ])('%s', (entry, message) => {
        expect(() => compileFilters([entry], kinds)).toThrowError(FilterSyntaxError);
        expect(() => compileFilters([entry], kinds)).toThrowError(message);
    });
});

describe('expression helpers', () => {
    it('ANDs optional expressions', () => {
        const a = inListExpression('hostName', ['a.com']);
        expect(andExpressions(undefined, a, undefined)).toEqual(a);
        expect(andExpressions(a, a)).toEqual({ andGroup: { expressions: [a, a] } });
        expect(andExpressions()).toBeUndefined();
    });

    it('converts to funnel filter expressions', () => {
        const { dimensionFilter } = compileFilters(['pagePath=^/checkout||pagePath=^/cart', 'country!=US'], kinds);
        expect(toFunnelFilterExpression(dimensionFilter!)).toEqual({
            andGroup: {
                expressions: [
                    {
                        orGroup: {
                            expressions: [
                                { funnelFieldFilter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/checkout', caseSensitive: false } } },
                                { funnelFieldFilter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/cart', caseSensitive: false } } },
                            ],
                        },
                    },
                    { notExpression: { funnelFieldFilter: { fieldName: 'country', stringFilter: { matchType: 'EXACT', value: 'US', caseSensitive: false } } } },
                ],
            },
        });
    });
});

describe('staticFieldKind', () => {
    it('classifies built-in and prefixed fields, leaving ambiguous customEvent: to metadata', () => {
        expect(staticFieldKind('pagePath')).toBe('dimension');
        expect(staticFieldKind('sessions')).toBe('metric');
        expect(staticFieldKind('customUser:tier')).toBe('dimension');
        expect(staticFieldKind('countCustomEvent:x')).toBe('metric');
        expect(staticFieldKind('keyEvents:sign_up')).toBe('metric');
        expect(staticFieldKind('customEvent:x')).toBeUndefined();
        expect(staticFieldKind('nope')).toBeUndefined();
    });
});
