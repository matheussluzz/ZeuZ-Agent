---
name: hefesto
description: Build accessible, secure, verified standalone HTML dashboards from local or sanitized data, using an offline HTML/CSS/SVG mode by default and Highcharts CDN or self-hosted modes only after explicit license confirmation. Use for dashboards, KPI pages, data stories, Highcharts-inspired visualizations, or HTML reporting artifacts.
---

# Hefesto

Build the smallest dashboard that answers the decision. Reconcile every KPI and chart with the input data before polishing visuals.

## Choose a rendering mode

- `offline-basic`: default; use original HTML/CSS/SVG and embedded sanitized data. No Highcharts, network, or external export service.
- `highcharts-cdn`: require explicit user confirmation that their use and license permit it. Use only the fixed official CDN allowlist and provide an offline textual/table fallback.
- `highcharts-self-hosted`: require explicit confirmation and user-provided licensed files. Never download or redistribute vendor binaries.

AI-generated Highcharts output remains subject to Highsoft licensing. A platform that lets third parties generate dashboards may require OEM terms. State that this is an engineering precaution, not legal advice. Never copy demo code; use official demos only as visual/design references and create original configuration.

## Progressive build

### 1. Freeze the dashboard contract

Use [assets/dashboard-brief.md](assets/dashboard-brief.md) to capture audience, decision, grain, period, refresh time, units, definitions, sources, filters, privacy class, success criteria, and rendering/license mode. Resolve competing KPI definitions before coding.

**Gate:** each KPI has one formula, numerator/denominator where applicable, aggregation rule, owner, and reconciliation total.

### 2. Reconcile and profile data

Confirm row counts, uniqueness, missingness, duplicates, joins, and aggregate tie-outs against the source. Exercise empty, null, zero, negative, outlier, unordered-date, sparse-series, long-label, and single-point cases. Do not convert missing values to zero unless the metric definition says they are equivalent.

**Gate:** record reconciliation evidence and unresolved data-quality limitations. Stop if the dashboard could imply a false comparison.

### 3. Design the information path

Sketch in this order: orientation, decision-driving KPIs, comparison/trend, diagnostic detail, definitions/source. Choose a chart from the analytical question and data shape, not aesthetics. Every chart needs a title, plain-language insight description, named series, axes/units, time zone where relevant, source, and equivalent table.

**Checkpoint:** show the hierarchy and chart choices before investing in polish when they materially affect interpretation.

### 4. Build defensively

Use a responsive original layout. Do not use color as the only signal. Support keyboard access, 200% zoom/reflow, high contrast, and reduced motion. Embed sanitized data only; normalize accepted fields, escape HTML and `</script>`, reject callbacks/arbitrary URLs, keep Highcharts HTML filtering enabled, and use a restrictive Content Security Policy. Disable external export fallback.

Run `node scripts/build-dashboard.mjs --help`. The builder accepts a deliberately small schema; extend it only with equally strict normalization.

### 5. Verify behavior and meaning

Run `node scripts/validate-dashboard.mjs <dashboard.html> --mode <mode>`. Then inspect at approximately 320, 768, and 1440 pixels with keyboard, zoom, console, and network checks. Recompute every displayed KPI/chart point from its source, test filter combinations, and review screenshots for clipping and misleading scales.

**Delivery evidence:** include the frozen brief, data/reconciliation limitations, generated HTML, renderer/license mode, deterministic validator result, manual viewports/accessibility checks, and any untested behavior. Passing scripts do not prove visual quality, accessibility conformance, semantic correctness, or license sufficiency.

Read [references/highcharts-safety.md](references/highcharts-safety.md) before either Highcharts mode and for the complete chart/security/QA checklist.
