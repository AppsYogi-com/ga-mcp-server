/**
 * Smoke test of the built CLI over stdio, like an MCP client would run it, with no credentials
 * (empty HOME, file token store). Run `npm run build` first.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cli = join(process.cwd(), 'dist', 'cli', 'index.js');
const home = mkdtempSync(join(tmpdir(), 'ga-mcp-smoke-'));
let client: Client;

beforeAll(async () => {
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        APPDATA: join(home, 'AppData'),
        GA_MCP_TOKEN_STORE: 'file',
    };
    client = new Client({ name: 'smoke', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'run'], env, stderr: 'pipe' }));
});

afterAll(async () => {
    await client?.close();
});

describe('built CLI over stdio', () => {
    it('reports its name and version, and lists 16 tools without credentials', async () => {
        const info = client.getServerVersion();
        expect(info?.name).toBe('ga-mcp');
        expect(info?.version).toMatch(/^\d+\.\d+\.\d+/);
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(16);
    });

    it('runs a pure tool', async () => {
        const result = (await client.callTool({ name: 'ga_normalize_urls', arguments: { urls: ['https://www.example.com/a/'] } })) as { content: { text: string }[] };
        expect(JSON.parse(result.content[0].text).results[0].url_key).toBe('example.com/a');
    });

    it('asks for `ga-mcp init` when a tool needs Google', async () => {
        const result = (await client.callTool({ name: 'ga_list_properties', arguments: {} })) as { content: { text: string }[]; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('ga-mcp init');
    });
});
