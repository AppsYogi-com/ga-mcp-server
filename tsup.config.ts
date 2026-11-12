import { readFileSync } from 'fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'cli/index': 'src/cli/index.ts',
    },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    dts: { entry: { index: 'src/index.ts' } },
    sourcemap: true,
    clean: true,
    splitting: false,
    // Single source of truth for the version reported by the CLI and MCP server
    define: {
        __PKG_VERSION__: JSON.stringify(pkg.version),
    },
});
