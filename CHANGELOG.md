# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-12

### Added
- **16 read-only MCP tools** for Google Analytics 4:
  - discovery: `ga_list_properties`, `ga_get_property`, `ga_search_fields`, `ga_normalize_urls`
  - reports: `ga_traffic_overview`, `ga_top_pages`, `ga_landing_pages`, `ga_pages_by_url`, `ga_acquisition`, `ga_key_events`
  - comparisons and opportunities: `ga_compare_periods`, `ga_declining_pages`, `ga_engagement_gaps`
  - general-purpose: `ga_run_report`, `ga_run_realtime_report`, `ga_run_funnel_report` (alpha)
- **`url_key` join contract:** page rows can be matched with Search Console, AdSense and Ahrefs URLs. `ga_pages_by_url` takes URL lists from those tools.
- **Property ↔ site host map** from web data streams. Any tool's `property` accepts an id or a host.
- **Friendly filter syntax:** `==`, `!=`, `=@`, `!@`, `=^`, `=$`, `=~`, `!~`, lists, and numeric comparisons for metrics, with OR groups and custom fields.
- **Comparisons use exact lookups ("anchor then lookup")**, and totals come from GA4 itself.
- **Every response includes:** a one-line summary, data-quality warnings (thresholding, sampling, `(other)` rows, partial today) and the remaining quota.
- **CLI:**
  - `init`: OAuth loopback with PKCE, `--reuse-client adsense|gsc`, service accounts, default property.
  - `doctor`: checks the Admin and Data APIs separately and shows quota.
  - `run`, `properties` and `logout`.
- **Tokens in the OS keychain** (`@napi-rs/keyring`), falling back to a file readable only by you (mode 600). The config file is also mode 600.

### Requirements
- Node.js 22.12 or newer.
- The Google Analytics Data API and Admin API enabled in the Google Cloud project of your OAuth client.
