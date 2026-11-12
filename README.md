# GA4-MCP-Server

> Google Analytics 4 MCP Server: GA4 data for Claude and other MCP clients, built to be **joined** with Search Console, AdSense and Ahrefs.

[![npm version](https://img.shields.io/npm/v/@appsyogi/ga-mcp-server.svg)](https://www.npmjs.com/package/@appsyogi/ga-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/AppsYogi-com/ga-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/AppsYogi-com/ga-mcp-server/actions/workflows/ci.yml)

Use it alongside [`@appsyogi/gsc-mcp-server`](https://github.com/AppsYogi-com/gsc-mcp-server), [`@appsyogi/adsense-mcp-server`](https://github.com/AppsYogi-com/adsense-mcp-server) and the Ahrefs MCP, so an AI agent can follow a page from search impression → click → session → engagement → key event → ad revenue.

## Features

- 🗺️ **Site ↔ property map**: every GA4 property is listed with the site hosts it tracks, so agents can match it to Search Console properties, AdSense sites and Ahrefs targets.
- 🔗 **Joinable pages**: every page row carries a normalized `url_key`, and `ga_pages_by_url` takes URLs from the other tools and returns GA4 metrics for each.
- 📊 **Ready-made reports**: traffic overview vs the previous period, top pages, landing pages (including organic only), acquisition, key events.
- 🔍 **Opportunity finders**: declining pages and high-traffic pages with low engagement or no key events.
- 🧰 **Escape hatches**: any GA4 report (friendly filter syntax), realtime, and funnels.
- 🪶 **Small and modern**: Node 22+, the per-API Google clients (~4 MB instead of the 200+ MB `googleapis`), no native build steps.
- 🔐 **Read-only and secure**: `analytics.readonly` scope only, tokens in your OS keychain, signed npm releases with provenance.

## Quick Start

```bash
npm install -g @appsyogi/ga-mcp-server
ga-mcp init --reuse-client adsense   # or: gsc, or paste a Client ID/Secret
ga-mcp doctor
```

Then [add it to your MCP client](#4-add-to-your-mcp-client).

## Requirements

- **Node.js 22.12 or newer**
- A Google account with access to your GA4 properties (Viewer is enough)
- A Google Cloud project with an OAuth **Desktop app** client. If you set one up for gsc-mcp or adsense-mcp, you can reuse it.

## Setup

### 1. Enable the GA4 APIs (one-time)

In the Google Cloud project that owns your OAuth client, enable both APIs:

- [Google Analytics Data API](https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com)
- [Google Analytics Admin API](https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com)

No OAuth client yet? Create one under **APIs & Services → Credentials → Create credentials → OAuth client ID**, with **Application type: Desktop app**. If the consent screen is in **Testing** mode, add your Google account as a **test user**.

### 2. Sign in

```bash
ga-mcp init --reuse-client adsense   # reuse adsense-mcp's OAuth client
ga-mcp init --reuse-client gsc       # or gsc-mcp's
ga-mcp init                          # or paste a Client ID and Secret
```

1. Your browser opens Google's sign-in page. Approve **read-only** Analytics access.
2. `init` lists your properties with the sites they track, and asks for a **default property**.

How it works: `init` starts a temporary local server on `http://127.0.0.1:<random port>`, and Google redirects back to it, using PKCE and a `state` check. The link is valid for 5 minutes.

**Service account alternative:**

```bash
ga-mcp init --service-account key.json
```

Then add the service account's email as a **Viewer** in each GA4 property, under **Admin → Property access management**. Service accounts never expire, unlike sign-ins on a Testing-mode consent screen.

### 3. Verify

```bash
ga-mcp doctor
```

`doctor` checks:
- the Node.js version, config and sign-in;
- the **Admin API** and **Data API** separately, so a disabled API is pinpointed, with its enable link;
- your remaining quota.

It also prints a ready-to-paste MCP config.

### 4. Add to your MCP client

#### Claude Desktop

> **Quit Claude Desktop before editing its config:** use ⌘Q on macOS, not just closing the window. While it's running, Claude Desktop keeps its own copy of the file and writes it back, so edits made with the app open can silently disappear.

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Add a `ga` entry under `mcpServers`, using full paths:

```json
{
    "mcpServers": {
        "ga": {
            "command": "/Users/you/.nvm/versions/node/v24.11.0/bin/node",
            "args": [
                "/Users/you/.nvm/versions/node/v24.11.0/lib/node_modules/@appsyogi/ga-mcp-server/dist/cli/index.js",
                "run"
            ]
        }
    }
}
```

`ga-mcp doctor` prints this config with the paths for your machine. Full paths matter because desktop apps don't load your shell's `PATH`, so nvm, fnm or asdf versions of `node` and `npx` often can't be found. Add `"--property", "<id or host>"` to `args` to change the default property.

#### Claude Code

```bash
claude mcp add ga -- ga-mcp run
```

#### VS Code (`.vscode/mcp.json`)

```json
{
    "servers": {
        "ga": { "type": "stdio", "command": "npx", "args": ["-y", "@appsyogi/ga-mcp-server", "run"] }
    }
}
```

## Tools

All tools are read-only.

| Tool | What it does |
|---|---|
| `ga_list_properties` | Properties and the site hosts they track. Filter by any host form (`example.com`, a URL, `sc-domain:example.com`); optionally include hosts seen in traffic |
| `ga_get_property` | Time zone, currency, web streams, key events, custom dimensions/metrics (with report API names) and whether AdSense is linked |
| `ga_search_fields` | Find dimension and metric names (including custom fields), optionally only those compatible with a planned report |
| `ga_normalize_urls` | Turn URLs from any tool into `url_key`s. No API call |
| `ga_traffic_overview` | KPIs vs the previous period or year, plus the channel breakdown, in one batched call |
| `ga_top_pages` | Pages by views, with sessions, users, engagement and key events, merged by `url_key` |
| `ga_landing_pages` | Entry pages; `organicOnly` matches Search Console page data |
| `ga_pages_by_url` | **Join tool:** GA4 metrics for a list of GSC, AdSense or Ahrefs URLs, with `found:false` for misses |
| `ga_acquisition` | By channel, source/medium, source, medium or campaign (session or first-user) |
| `ga_key_events` | Key events (conversions), optionally by channel, landing page or page |
| `ga_compare_periods` | Any breakdown, current vs previous, with exact per-row changes and true totals |
| `ga_declining_pages` | Pages that lost the most sessions or views (`organicOnly` for SEO losses) |
| `ga_engagement_gaps` | High-traffic pages with low engagement or no key events, each with a reason |
| `ga_run_report` | Any GA4 report: up to 9 dimensions and 10 metrics, filters, comparison, granularity, pagination |
| `ga_run_realtime_report` | Last 30 minutes by page/screen, country, device or event |
| `ga_run_funnel_report` | **Alpha.** Step-by-step funnels (open or closed, breakdown, trended); uses GA4's v1alpha API |

**Common parameters:**
- `property`: an id (`123456789`), `properties/123`, or a site host/URL. The default comes from `init`, or from `run --property`.
- **Dates:** `dateRange` (`last7d`, `last28d`, `last90d`, `last365d`, `this_month`, `last_month`) or `startDate`/`endDate` (`YYYY-MM-DD`, `NdaysAgo`, `yesterday`). The default is the **last 28 complete days in the property's time zone**.
- `format`: `compact` (the default, a columns list plus row arrays, which saves tokens) or `full` (one object per row).

**Every response includes:**
- a one-line `summary`;
- `totals` from GA4 itself, not summed from the visible rows;
- `next_offset` for pagination;
- `warnings`: thresholding, sampling, `(other)` rows, ranges that include today, low quota;
- `quota` left.

## Joining data: the `url_key` contract

Page rows from every tool carry a `url_key`, built the same way from any URL form:

```
https://www.Example.com/blog/post/?utm_source=x#top   →   example.com/blog/post
```

1. The host is lowercased and converted to punycode; a leading `www.` and any port are removed.
2. The query string and fragment are dropped.
3. Percent-encoding is normalized, and repeated slashes are collapsed.
4. A trailing `/` (except at the root) and a trailing `/index.html` are removed.
5. **The path's case is kept**, because servers treat paths as case-sensitive.

Recipes:
- **Search Console → GA4:** get GSC's top pages, then call `ga_pages_by_url` with `mode: "landing", organicOnly: true`. Clicks become sessions, engagement and key events per page. Or join `ga_landing_pages` with `organicOnly` on `url_key`.
- **AdSense → GA4:** AdSense `PAGE_URL` rows plus `ga_top_pages` or `ga_pages_by_url` (`mode: "page"`) show revenue per view and engagement per page.
- **Ahrefs → GA4:** top organic pages or backlink targets plus `ga_pages_by_url` show which ranking pages actually engage and convert.
- **Site level:** `ga_list_properties` maps hosts to property ids, and `property` accepts a host directly.

**Why a URL can come back `found: false`:**
- **Redirects.** Search Console can keep reporting clicks on a URL that redirects. GA4 records the visit on the destination page instead. A redirected URL that still gets many search clicks is itself a finding: update internal links and the sitemap so Google consolidates onto the destination.
- **The page has no GA4 tag.**
- **No sessions or views** for that page in the period.

In a live test on a real site, URLs matching **94% of Search Console clicks** joined directly. Nearly all of the clicks that didn't match went to two URLs that redirect.

## Filter syntax

`filters` is a list of strings combined with **AND**; `||` inside one entry means **OR**.

| Syntax | Meaning |
|---|---|
| `field==value` / `field!=value` | exact match / not equal |
| `field=@text` / `field!@text` | contains / does not contain |
| `field=^text` / `field=$text` | begins with / ends with |
| `field=~regex` / `field!~regex` | matches / doesn't match a regular expression |
| `field=[a,b,c]` | one of a list |
| `metric>n`, `<`, `>=`, `<=`, `==`, `!=` | numeric comparison (applied after aggregation, like SQL `HAVING`) |

Examples:
- `"sessionDefaultChannelGroup==Organic Search"`
- `"pagePath=^/blog/||pagePath=^/guides/"`
- `"country=[India,United States]"`
- `"sessions>=100"`

Matching is case-insensitive. Custom fields work too (`customEvent:plan==pro`). To use a literal `|` or `,`, escape it as `\|` or `\,`. For anything else, `ga_run_report` also accepts a raw GA4 `dimensionFilter`/`metricFilter`.

## Quotas and data quality

- **Quota:** GA4 meters requests in tokens per property: 200k a day, 40k an hour, and 14k an hour per Cloud project (standard properties). Every response includes the remaining quota, and tools warn when less than 10% is left. Opinionated tools use 1–3 requests, batched where possible, and identical reports are cached for 5 minutes.
- **Thresholding** (small user counts, demographics), **sampling** and **`(other)` rows** are flagged in `warnings`. Treat flagged numbers as approximate.
- **Today:** data for the current day is incomplete, which is why default ranges end yesterday.

## Data storage

| What | Where |
|---|---|
| Config (`config.json`, OAuth client, default property; mode 600) | macOS: `~/Library/Preferences/ga-mcp/`<br>Linux: `~/.config/ga-mcp/`<br>Windows: `%APPDATA%\ga-mcp\Config\` |
| OAuth tokens | OS keychain (service `ga-mcp`). Falls back to `tokens.json` in the config folder (mode 600); set `GA_MCP_TOKEN_STORE=file` to force it |
| Service account key (if used) | `service-account.json` in the config folder (mode 600) |

`ga-mcp logout` removes the sign-in; `ga-mcp logout --all` also removes the config.

## CLI

| Command | Purpose |
|---|---|
| `ga-mcp init [--reuse-client adsense\|gsc] [--client-id … --client-secret …] [--service-account key.json] [--port n] [--default id\|host]` | Sign in and choose a default property |
| `ga-mcp doctor` | Check setup, APIs and quota; print client configs |
| `ga-mcp run [--property id\|host]` | Start the MCP server over stdio (your MCP client runs this) |
| `ga-mcp properties` | Print the property ↔ host map |
| `ga-mcp logout [--all]` | Remove the saved sign-in (and config) |

## Troubleshooting

Start with `ga-mcp doctor`.

- **"The Google Analytics Data/Admin API isn't enabled"**: enable it in the same Cloud project as your OAuth client (links above), wait a minute, and retry.
- **"Error 400: redirect_uri_mismatch"**: your OAuth client isn't a **Desktop app** client.
- **"Access blocked" / `access_denied`**: add your Google account as a test user on the OAuth consent screen.
- **`invalid_grant` after a week**: Testing-mode consent screens expire sign-ins after 7 days. Run `ga-mcp init` again, publish the app (**In production**), or use a service account.
- **"can't access this GA4 property"**: your account (or service account) needs at least Viewer access on that property.
- **"Several GA4 properties match" / "pass `property`"**: give a property id, or set a default with `ga-mcp init --default <id>` or `run --property <id>`.
- **Claude Desktop doesn't show the server**:
  - Check `~/Library/Logs/Claude/mcp-server-ga.log`.
  - "needs Node.js 22.12" means Claude Desktop started an older `node`; use full paths.
  - Quit with ⌘Q before editing the config.

## Development

```bash
git clone https://github.com/AppsYogi-com/ga-mcp-server.git
cd ga-mcp-server
npm install
npm run typecheck && npm run lint && npm test
npm run build && npm run test:smoke
```

- **`test/unit`:** pure helpers (`url_key`, filters, dates, formatting).
- **`test/tools`:** every tool against an in-memory MCP client and a fake GA client.
- **`test/smoke`:** the built CLI over stdio.

Releases are published from GitHub Actions through npm trusted publishing. Each release is staged on npm, a maintainer approves it with 2FA, and it carries a provenance attestation.

## License

MIT

## Credits

Built with [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk), [@googleapis/analyticsdata](https://www.npmjs.com/package/@googleapis/analyticsdata), [@googleapis/analyticsadmin](https://www.npmjs.com/package/@googleapis/analyticsadmin), [google-auth-library](https://github.com/googleapis/google-auth-library-nodejs), [@napi-rs/keyring](https://github.com/Brooooooklyn/keyring-node), [commander](https://github.com/tj/commander.js) and [zod](https://zod.dev).
