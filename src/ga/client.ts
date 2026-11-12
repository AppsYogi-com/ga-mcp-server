/**
 * GA4 API access. Tools depend on the GaClient interface, so tests can inject a fake.
 * Uses the per-API REST packages (@googleapis/analyticsdata, @googleapis/analyticsadmin).
 */

import { analyticsadmin } from '@googleapis/analyticsadmin';
import { analyticsdata } from '@googleapis/analyticsdata';
import type { AuthClient } from '../auth/oauth.js';
import type { GaReportResponse } from '../lib/format.js';
import { PropertyLimiter } from './limiter.js';

export interface PropertySummary {
    id: string;
    displayName: string;
    accountId: string;
    accountName: string;
}

export interface DataStream {
    id: string;
    displayName: string;
    type: string;
    defaultUri: string | null;
    measurementId: string | null;
}

export interface PropertyDetails {
    id: string;
    displayName: string;
    timeZone: string;
    currencyCode: string;
    serviceLevel: string | null;
    industryCategory: string | null;
    createTime: string | null;
}

export interface FieldMetadata {
    apiName: string;
    uiName: string;
    description: string;
    category: string;
    kind: 'dimension' | 'metric';
    type?: string;
    custom: boolean;
}

export interface GaClient {
    listPropertySummaries(): Promise<PropertySummary[]>;
    getProperty(propertyId: string): Promise<PropertyDetails>;
    listDataStreams(propertyId: string): Promise<DataStream[]>;
    listKeyEvents(propertyId: string): Promise<{ eventName: string; countingMethod: string | null; createTime: string | null }[]>;
    listCustomDimensions(propertyId: string): Promise<{ parameterName: string; displayName: string; scope: string }[]>;
    listCustomMetrics(propertyId: string): Promise<{ parameterName: string; displayName: string; scope: string; unit: string | null }[]>;
    /** v1alpha, best effort: null when the API refuses or isn't available. */
    listAdSenseLinks(propertyId: string): Promise<{ adClientCode: string }[] | null>;
    runReport(propertyId: string, request: Record<string, unknown>): Promise<GaReportResponse>;
    batchRunReports(propertyId: string, requests: Record<string, unknown>[]): Promise<GaReportResponse[]>;
    runRealtimeReport(propertyId: string, request: Record<string, unknown>): Promise<GaReportResponse>;
    /** Pass "0" for the universal metadata (no custom fields). */
    getMetadata(propertyId: string): Promise<FieldMetadata[]>;
    checkCompatibility(propertyId: string, request: Record<string, unknown>): Promise<{ dimensions: string[]; metrics: string[] }>;
    /** v1alpha runFunnelReport (not in the generated client, so called over REST). */
    runFunnelReport(propertyId: string, request: Record<string, unknown>): Promise<any>;
}

const lastSegment = (name: string | null | undefined) => (name ?? '').split('/').pop() ?? '';

export class GoogleGaClient implements GaClient {
    private readonly data;
    private readonly admin;
    private readonly adminAlpha;
    private readonly limiter = new PropertyLimiter(4);

    constructor(private readonly auth: AuthClient) {
        this.data = analyticsdata({ version: 'v1beta', auth: auth as any });
        this.admin = analyticsadmin({ version: 'v1beta', auth: auth as any });
        this.adminAlpha = analyticsadmin({ version: 'v1alpha', auth: auth as any });
    }

    async listPropertySummaries(): Promise<PropertySummary[]> {
        const out: PropertySummary[] = [];
        let pageToken: string | undefined;
        do {
            const res = await this.limiter.run('admin', () => this.admin.accountSummaries.list({ pageSize: 200, pageToken }));
            for (const account of res.data.accountSummaries ?? []) {
                for (const p of account.propertySummaries ?? []) {
                    out.push({
                        id: lastSegment(p.property),
                        displayName: p.displayName ?? '',
                        accountId: lastSegment(account.account),
                        accountName: account.displayName ?? '',
                    });
                }
            }
            pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
        return out;
    }

    async getProperty(propertyId: string): Promise<PropertyDetails> {
        const res = await this.limiter.run(propertyId, () => this.admin.properties.get({ name: `properties/${propertyId}` }));
        const p = res.data;
        return {
            id: propertyId,
            displayName: p.displayName ?? '',
            timeZone: p.timeZone ?? 'UTC',
            currencyCode: p.currencyCode ?? 'USD',
            serviceLevel: p.serviceLevel ?? null,
            industryCategory: p.industryCategory ?? null,
            createTime: p.createTime ?? null,
        };
    }

    async listDataStreams(propertyId: string): Promise<DataStream[]> {
        const res = await this.limiter.run(propertyId, () =>
            this.admin.properties.dataStreams.list({ parent: `properties/${propertyId}`, pageSize: 200 }),
        );
        return (res.data.dataStreams ?? []).map((s) => ({
            id: lastSegment(s.name),
            displayName: s.displayName ?? '',
            type: s.type ?? '',
            defaultUri: s.webStreamData?.defaultUri ?? null,
            measurementId: s.webStreamData?.measurementId ?? null,
        }));
    }

    async listKeyEvents(propertyId: string) {
        const res = await this.limiter.run(propertyId, () =>
            this.admin.properties.keyEvents.list({ parent: `properties/${propertyId}`, pageSize: 200 }),
        );
        return (res.data.keyEvents ?? []).map((k) => ({
            eventName: k.eventName ?? '',
            countingMethod: k.countingMethod ?? null,
            createTime: k.createTime ?? null,
        }));
    }

    async listCustomDimensions(propertyId: string) {
        const res = await this.limiter.run(propertyId, () =>
            this.admin.properties.customDimensions.list({ parent: `properties/${propertyId}`, pageSize: 200 }),
        );
        return (res.data.customDimensions ?? []).map((d) => ({
            parameterName: d.parameterName ?? '',
            displayName: d.displayName ?? '',
            scope: d.scope ?? '',
        }));
    }

    async listCustomMetrics(propertyId: string) {
        const res = await this.limiter.run(propertyId, () =>
            this.admin.properties.customMetrics.list({ parent: `properties/${propertyId}`, pageSize: 200 }),
        );
        return (res.data.customMetrics ?? []).map((m) => ({
            parameterName: m.parameterName ?? '',
            displayName: m.displayName ?? '',
            scope: m.scope ?? '',
            unit: m.measurementUnit ?? null,
        }));
    }

    async listAdSenseLinks(propertyId: string) {
        try {
            const res = await this.limiter.run(propertyId, () =>
                this.adminAlpha.properties.adSenseLinks.list({ parent: `properties/${propertyId}` }),
            );
            return (res.data.adsenseLinks ?? []).map((l) => ({ adClientCode: l.adClientCode ?? '' }));
        } catch {
            return null;
        }
    }

    async runReport(propertyId: string, request: Record<string, unknown>): Promise<GaReportResponse> {
        const res = await this.limiter.run(propertyId, () =>
            this.data.properties.runReport({ property: `properties/${propertyId}`, requestBody: request }),
        );
        return res.data as GaReportResponse;
    }

    async batchRunReports(propertyId: string, requests: Record<string, unknown>[]): Promise<GaReportResponse[]> {
        const res = await this.limiter.run(propertyId, () =>
            this.data.properties.batchRunReports({ property: `properties/${propertyId}`, requestBody: { requests } }),
        );
        return (res.data.reports ?? []) as GaReportResponse[];
    }

    async runRealtimeReport(propertyId: string, request: Record<string, unknown>): Promise<GaReportResponse> {
        const res = await this.limiter.run(propertyId, () =>
            this.data.properties.runRealtimeReport({ property: `properties/${propertyId}`, requestBody: request }),
        );
        return res.data as GaReportResponse;
    }

    async getMetadata(propertyId: string): Promise<FieldMetadata[]> {
        const res = await this.limiter.run(propertyId, () =>
            this.data.properties.getMetadata({ name: `properties/${propertyId}/metadata` }),
        );
        const dims: FieldMetadata[] = (res.data.dimensions ?? []).map((d) => ({
            apiName: d.apiName ?? '',
            uiName: d.uiName ?? '',
            description: d.description ?? '',
            category: d.category ?? '',
            kind: 'dimension',
            custom: !!d.customDefinition,
        }));
        const metrics: FieldMetadata[] = (res.data.metrics ?? []).map((m) => ({
            apiName: m.apiName ?? '',
            uiName: m.uiName ?? '',
            description: m.description ?? '',
            category: m.category ?? '',
            kind: 'metric',
            type: m.type ?? undefined,
            custom: !!m.customDefinition,
        }));
        return [...dims, ...metrics];
    }

    async checkCompatibility(propertyId: string, request: Record<string, unknown>) {
        const res = await this.limiter.run(propertyId, () =>
            this.data.properties.checkCompatibility({ property: `properties/${propertyId}`, requestBody: request }),
        );
        return {
            dimensions: (res.data.dimensionCompatibilities ?? [])
                .filter((d) => d.compatibility === 'COMPATIBLE')
                .map((d) => d.dimensionMetadata?.apiName ?? ''),
            metrics: (res.data.metricCompatibilities ?? [])
                .filter((m) => m.compatibility === 'COMPATIBLE')
                .map((m) => m.metricMetadata?.apiName ?? ''),
        };
    }

    async runFunnelReport(propertyId: string, request: Record<string, unknown>): Promise<any> {
        const client = this.auth as { request: (opts: Record<string, unknown>) => Promise<{ data: unknown }> };
        const res = await this.limiter.run(propertyId, () =>
            client.request({
                url: `https://analyticsdata.googleapis.com/v1alpha/properties/${propertyId}:runFunnelReport`,
                method: 'POST',
                data: request,
            }),
        );
        return res.data;
    }
}
