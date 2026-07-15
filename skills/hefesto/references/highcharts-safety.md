# Dashboard safety and licensing

## Modes

`offline-basic` contains no Highcharts assets and must work with the network disabled. `highcharts-cdn` uses only fixed official CDN URLs after license confirmation. `highcharts-self-hosted` references a user-supplied licensed bundle (including the accessibility and approved export/data modules the dashboard needs) and never downloads it. Verify the bundle contents at runtime; a filename cannot prove module availability.

Highsoft states that AI-generated output remains subject to its license and agent-builder/OEM scenarios may need special terms. Commercial use includes internal business, prototype, research, presentation, government, and nonprofit contexts. Confirm the user's terms; do not infer a license from accessibility of the CDN. This is not legal advice.

Record who confirmed the license, the permitted use, and the confirmation date in the dashboard brief. License confirmation is a human/legal gate; a CLI flag is only an auditable assertion.

## Data and interpretation contract

- Define metric grain, population, numerator, denominator, exclusions, time zone, currency/unit, aggregation, freshness, and comparison period.
- Reconcile source row counts and control totals before transformation, after joins, and after aggregation.
- Keep missing, zero, not applicable, suppressed, and unavailable visually and semantically distinct.
- Start quantitative axes at zero for bars unless a documented analytical reason and visible cue justify otherwise. Do not imply continuity for gaps.
- Show uncertainty intervals and provisional data explicitly. Never infer causality from a trend or correlation.
- Limit precision to what the source supports. State whether changes are absolute, relative, or percentage points.

## Chart choice

| Question | Usually suitable | Common failure |
| --- | --- | --- |
| Change over ordered time | line or small multiple | unordered dates, hidden gaps, dual axes |
| Compare categories | sorted bar/dot plot | truncated bar axis, too many categories |
| Part-to-whole | stacked bar when totals are comparable | pie slices or stacks that are hard to compare |
| Distribution | histogram, box, strip plot | averages hiding skew/outliers |
| Relationship | scatter with uncertainty/context | causal wording or overplotting |

Use a table when exact lookup matters more than shape. Avoid 3D, decorative encodings, and dual axes unless the decision genuinely needs them and the relationship cannot be shown more honestly another way.

## Security and accessibility

- Keep configuration JSON-only; reject functions, callbacks, arbitrary script URLs, and untrusted HTML.
- Escape embedded JSON, including `</script>`.
- Keep HTML filtering enabled. Use a restrictive CSP.
- Use local client export and `fallbackToExportServer: false`.
- Add titles, linked descriptions, axes/units, named series, source, keyboard navigation, and a data table.
- Do not rely only on color; test contrast, zoom, reduced motion, long labels, empty/null/negative/outlier data, and disconnected network.
- Normalize data into a minimal allowlisted schema before passing it to a chart library. JSON cannot contain a JavaScript function, but untrusted option names, URLs, or HTML strings can still change behavior.
- Treat dashboards as data releases: remove secrets, direct identifiers, small-cell disclosures, hidden tooltip data, comments, and source paths before embedding.

## Verification layers

1. **Structure:** deterministic HTML/CSP/allowlist checks.
2. **Data:** independent recomputation of KPIs, series, filters, and reconciliation totals.
3. **Interaction:** keyboard, focus order, tooltips, controls, empty/error/loading states, and disconnected network.
4. **Visual:** 320/768/1440 widths, 200% zoom, contrast, clipping, label collisions, and print/export.
5. **Interpretation:** title/description, scale, comparison period, uncertainty, source, and caveats support the intended decision without overclaiming.

No single automated tool proves Web Content Accessibility Guidelines conformance. Record browser, viewport, test data, and observed failures.

## Primary sources

- Demos: https://www.highcharts.com/demo
- Installation: https://www.highcharts.com/docs/getting-started/installation
- Security: https://www.highcharts.com/docs/chart-concepts/security
- Accessibility: https://www.highcharts.com/docs/accessibility/accessibility-module
- Client-side export: https://www.highcharts.com/docs/export-module/client-side-export
- License: https://shop.highcharts.com/license
- EULA/AUP: https://shop.highcharts.com/license-eula
- W3C charts tutorial: https://www.w3.org/WAI/tutorials/images/complex/
- WCAG 2.2: https://www.w3.org/TR/WCAG22/
