/**
 * Shared state for tools and the CLI: the (lazily created) GA client, caches, the
 * property <-> hostname map, property resolution, and field-kind lookup for filters.
 */

import { createAuthClient } from '../auth/oauth.js';
import { TTL, TtlCache } from '../ga/cache.js';
import { GoogleGaClient, type DataStream, type FieldMetadata, type GaClient, type PropertyDetails } from '../ga/client.js';
import { UserInputError } from '../ga/errors.js';
import { staticFieldKind, type FieldKind } from '../lib/fields.js';
import { normalizeHost } from '../lib/urlKey.js';

export interface PropertyWithHosts {
    property_id: string;
    name: string;
    account: string;
    account_id: string;
    /** Normalized hostnames of the property's web streams (www stripped). */
    hosts: string[];
    streams: { id: string; name: string; default_uri: string | null; measurement_id: string | null }[];
}

export interface ContextOptions {
    /** Creates the GA client on first use. Defaults to the saved sign-in. */
    clientFactory?: () => Promise<GaClient>;
    /** Default property (id or host) from `ga-mcp run --property`. */
    defaultProperty?: string;
}

export class ServerContext {
    readonly cache = new TtlCache();
    readonly defaultProperty?: string;
    private readonly clientFactory: () => Promise<GaClient>;
    private clientPromise?: Promise<GaClient>;

    constructor(options: ContextOptions = {}) {
        this.defaultProperty = options.defaultProperty;
        this.clientFactory = options.clientFactory ?? (async () => new GoogleGaClient(await createAuthClient()));
    }

    /** The GA client, created on first use. A failed attempt (e.g. not signed in) is retried next time. */
    client(): Promise<GaClient> {
        if (!this.clientPromise) {
            this.clientPromise = this.clientFactory().catch((error) => {
                this.clientPromise = undefined;
                throw error;
            });
        }
        return this.clientPromise;
    }

    /** Every property the account can see, with its web stream hosts. */
    async propertyMap(): Promise<PropertyWithHosts[]> {
        return this.cache.getOrSet('propertyMap', TTL.properties, async () => {
            const client = await this.client();
            const summaries = await client.listPropertySummaries();
            return Promise.all(
                summaries.map(async (p) => {
                    let streams: DataStream[] = [];
                    try {
                        streams = await client.listDataStreams(p.id);
                    } catch {
                        // no access to streams: still list the property
                    }
                    const web = streams.filter((s) => s.type === 'WEB_DATA_STREAM' || s.defaultUri);
                    const hosts = [...new Set(web.map((s) => normalizeHost(s.defaultUri)).filter((h): h is string => !!h))];
                    return {
                        property_id: p.id,
                        name: p.displayName,
                        account: p.accountName,
                        account_id: p.accountId,
                        hosts,
                        streams: web.map((s) => ({ id: s.id, name: s.displayName, default_uri: s.defaultUri, measurement_id: s.measurementId })),
                    };
                }),
            );
        });
    }

    /** Properties whose web streams match a host (exact first, then parent domains). */
    async propertiesForHost(input: string): Promise<PropertyWithHosts[]> {
        const host = normalizeHost(input);
        if (!host) return [];
        const map = await this.propertyMap();
        const exact = map.filter((p) => p.hosts.includes(host));
        if (exact.length > 0) return exact;
        // blog.example.com -> a property streaming example.com
        return map.filter((p) => p.hosts.some((h) => host.endsWith(`.${h}`)));
    }

    /** Resolve an id, "properties/123", a host/URL, or the default into one property's details. */
    async property(input?: string): Promise<PropertyDetails & { hosts: string[] }> {
        const value = (input ?? this.defaultProperty)?.trim();
        let id: string | undefined;

        if (!value) {
            const map = await this.propertyMap();
            if (map.length === 1) id = map[0].property_id;
            else if (map.length === 0) throw new UserInputError('No GA4 properties are visible to this Google account.');
            else {
                throw new UserInputError(
                    `This account can see ${map.length} GA4 properties; pass \`property\` (an id or a site host such as example.com). ` +
                        'Use ga_list_properties to see them, or start the server with `ga-mcp run --property <id|host>`.',
                );
            }
        } else if (/^(properties\/)?\d+$/.test(value)) {
            id = value.replace(/^properties\//, '');
        } else {
            const matches = await this.propertiesForHost(value);
            if (matches.length === 1) id = matches[0].property_id;
            else if (matches.length === 0) {
                throw new UserInputError(`No GA4 property has a web stream for "${value}". Use ga_list_properties (with includeObservedHosts) to check.`);
            } else {
                const list = matches.map((m) => `${m.property_id} (${m.name})`).join(', ');
                throw new UserInputError(`Several GA4 properties match "${value}": ${list}. Pass the property id instead.`);
            }
        }

        const propertyId = id!;
        const client = await this.client();
        const details = await this.cache.getOrSet(`property:${propertyId}`, TTL.properties, () => client.getProperty(propertyId));
        let hosts: string[] = [];
        try {
            hosts = (await this.propertyMap()).find((p) => p.property_id === propertyId)?.hosts ?? [];
        } catch {
            // the host map is only a convenience here
        }
        return { ...details, hosts };
    }

    /** Field metadata for a property (custom fields included), cached for a day. */
    async metadata(propertyId: string): Promise<FieldMetadata[]> {
        const client = await this.client();
        return this.cache.getOrSet(`metadata:${propertyId}`, TTL.metadata, () => client.getMetadata(propertyId));
    }

    /**
     * A synchronous field-kind resolver for the filter compiler. Property metadata is only
     * fetched when some names aren't known statically (e.g. customEvent:x).
     */
    async kindResolver(propertyId: string, names: string[]): Promise<(name: string) => FieldKind | undefined> {
        const unknown = names.filter((n) => !staticFieldKind(n));
        if (unknown.length === 0) return staticFieldKind;
        let byName = new Map<string, FieldKind>();
        try {
            byName = new Map((await this.metadata(propertyId)).map((f) => [f.apiName, f.kind]));
        } catch {
            // fall back to static knowledge only
        }
        return (name) => staticFieldKind(name) ?? byName.get(name);
    }
}

/** Field names used in friendly filter strings (for kind lookup). */
export function filterFieldNames(filters: string[] | undefined): string[] {
    const names: string[] = [];
    for (const entry of filters ?? []) {
        for (const part of entry.split('||')) {
            const match = /^\s*([A-Za-z][A-Za-z0-9_]*(?::[A-Za-z0-9_.-]+)?)/.exec(part);
            if (match) names.push(match[1]);
        }
    }
    return names;
}
