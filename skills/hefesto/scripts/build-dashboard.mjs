#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) values.set(name, true);
    else {
      values.set(name, value);
      index += 1;
    }
  }
  return values;
}

function fail(message) {
  throw new Error(`Invalid dashboard input: ${message}`);
}

function string(value, field, { required = true, max = 500 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (value.length > max) fail(`${field} exceeds ${max} characters`);
  return value;
}

function list(value, field, max) {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length > max) fail(`${field} exceeds ${max} items`);
  return value;
}

const options = parseArgs(process.argv.slice(2));
if (options.has('--help') || !options.get('--input') || !options.get('--output')) {
  process.stdout.write('Usage: node build-dashboard.mjs --input data.json --output dashboard.html [--mode offline-basic|highcharts-cdn|highcharts-self-hosted] [--license-confirmed] [--script ./vendor/highcharts.js]\n');
  process.exit(options.has('--help') ? 0 : 2);
}

const mode = String(options.get('--mode') ?? 'offline-basic');
if (!['offline-basic', 'highcharts-cdn', 'highcharts-self-hosted'].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
if (mode !== 'offline-basic' && !options.has('--license-confirmed')) throw new Error('Highcharts modes require --license-confirmed. Confirm the applicable Highsoft license before generating.');
const selfHostedScript = options.get('--script');
if (mode === 'highcharts-self-hosted') {
  if (typeof selfHostedScript !== 'string') throw new Error('Self-hosted mode requires --script with a user-provided licensed relative path.');
  if (isAbsolute(selfHostedScript) || selfHostedScript.includes('..') || /^[a-z]+:/i.test(selfHostedScript) || !/^[A-Za-z0-9_./-]+\.js$/.test(selfHostedScript)) throw new Error('Self-hosted script must be a safe relative JavaScript path.');
  const scriptPath = resolve(dirname(String(options.get('--output'))), selfHostedScript);
  const metadata = await stat(scriptPath).catch(() => undefined);
  if (!metadata?.isFile()) throw new Error(`Self-hosted licensed bundle was not found beside the output: ${selfHostedScript}`);
}

const raw = JSON.parse(await readFile(String(options.get('--input')), 'utf8'));
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('root must be an object');
const title = string(raw.title, 'title', { max: 160 });
const subtitle = string(raw.subtitle, 'subtitle', { required: false });
const source = string(raw.source, 'source', { max: 300 });
const updatedAt = string(raw.updatedAt, 'updatedAt', { max: 80 });
const language = string(raw.language ?? 'en', 'language', { max: 35 });
if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) fail('language must be a simple BCP 47 tag');

const rawKpis = list(raw.kpis ?? [], 'kpis', 24);
const kpis = rawKpis.map((item, index) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`kpis[${index}] must be an object`);
  return {
    label: string(item.label, `kpis[${index}].label`, { max: 120 }),
    value: string(item.value, `kpis[${index}].value`, { max: 80 }),
    detail: string(item.detail, `kpis[${index}].detail`, { required: false, max: 240 }),
  };
});

if (!raw.chart || typeof raw.chart !== 'object' || Array.isArray(raw.chart)) fail('chart must be an object');
const chart = {
  title: string(raw.chart.title, 'chart.title', { max: 160 }),
  description: string(raw.chart.description, 'chart.description', { max: 600 }),
  unit: string(raw.chart.unit, 'chart.unit', { max: 60 }),
  categories: list(raw.chart.categories, 'chart.categories', 200).map((value, index) => string(value, `chart.categories[${index}]`, { max: 100 })),
  series: list(raw.chart.series, 'chart.series', 20).map((item, seriesIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`chart.series[${seriesIndex}] must be an object`);
    const data = list(item.data, `chart.series[${seriesIndex}].data`, 200).map((value, pointIndex) => {
      if (value === null) return null;
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`chart.series[${seriesIndex}].data[${pointIndex}] must be a finite number or null`);
      return value;
    });
    if (data.length !== raw.chart.categories.length) fail(`chart.series[${seriesIndex}].data length must match categories`);
    return { name: string(item.name, `chart.series[${seriesIndex}].name`, { max: 100 }), data };
  }),
};
if (!chart.categories.length || !chart.series.length) fail('chart requires at least one category and series');

const text = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const json = (value) => JSON.stringify(value).replace(/<\//g, '<\\/');
const allNumbers = chart.series.flatMap((item) => item.data).filter((value) => value !== null).map(Math.abs);
const max = Math.max(1, ...allNumbers);
const bars = chart.series.map((item) => `<section class="series-bars"><h3>${text(item.name)}</h3>${item.data.map((value, index) => {
  const width = value === null ? 0 : Math.max(0, (Math.abs(value) / max) * 50);
  const valueLabel = value === null ? 'Missing' : `${value} ${chart.unit}`;
  return `<div class="bar-row"><span>${text(chart.categories[index])}</span><div class="bar-track" aria-hidden="true"><div class="bar ${value !== null && value < 0 ? 'negative' : 'positive'}" style="width:${width}%"></div></div><strong>${text(valueLabel)}</strong></div>`;
}).join('')}</section>`).join('');
const tableHeader = chart.categories.map((category) => `<th scope="col">${text(category)}</th>`).join('');
const tableRows = chart.series.map((item) => `<tr><th scope="row">${text(item.name)}</th>${item.data.map((value) => `<td>${value === null ? '—' : text(value)}</td>`).join('')}</tr>`).join('');
const kpiMarkup = kpis.map((item) => `<article class="kpi"><span>${text(item.label)}</span><strong>${text(item.value)}</strong><small>${text(item.detail)}</small></article>`).join('');

const highchartsScripts = mode === 'highcharts-cdn'
  ? '<script src="https://code.highcharts.com/highcharts.js"></script><script src="https://code.highcharts.com/modules/exporting.js"></script><script src="https://code.highcharts.com/modules/export-data.js"></script><script src="https://code.highcharts.com/modules/accessibility.js"></script>'
  : mode === 'highcharts-self-hosted' ? `<script src="${text(selfHostedScript)}"></script>` : '';
const chartBody = mode === 'offline-basic'
  ? `<div class="bars" role="img" aria-label="${text(chart.description)}">${bars}</div>`
  : '<div id="chart" aria-describedby="chart-description"></div><noscript>JavaScript is required for the chart. Use the data table below.</noscript>';
const highchartsInit = mode === 'offline-basic' ? '' : `<script>
const dashboardData=${json({ categories: chart.categories, series: chart.series })};
if(window.Highcharts){Highcharts.chart('chart',{title:{text:${json(chart.title)}},accessibility:{description:${json(chart.description)}},xAxis:{categories:dashboardData.categories},yAxis:{title:{text:${json(chart.unit)}}},tooltip:{valueSuffix:' '+${json(chart.unit)}},exporting:{fallbackToExportServer:false,buttons:{contextButton:{menuItems:['viewData','downloadCSV']}}},series:dashboardData.series});}
</script>`;
const csp = mode === 'highcharts-cdn'
  ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://code.highcharts.com; img-src data:; font-src 'self'; connect-src 'none'"
  : "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'self'; img-src data:; font-src 'self'; connect-src 'none'";
const licenseMeta = mode === 'offline-basic' ? '' : '<meta name="zeuz-highcharts-license-confirmed" content="true">';

const html = `<!doctype html>
<html lang="${text(language)}" data-zeuz-render-mode="${text(mode)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}">${licenseMeta}
<title>${text(title)}</title><style>
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#07162f;color:#edf5ff}*{box-sizing:border-box}body{margin:0;padding:clamp(1rem,4vw,3rem);background:radial-gradient(circle at top,#123c74,#07162f 60%)}main{max-width:1100px;margin:auto}.meta{color:#a9c8ed}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin:2rem 0}.kpi,.panel{background:#0c2446;border:1px solid #245da0;border-radius:16px;padding:1.2rem}.kpi span,.kpi small{display:block;color:#a9c8ed}.kpi strong{display:block;font-size:2rem;margin:.35rem 0}.series-bars+ .series-bars{margin-top:1.5rem}.bar-row{display:grid;grid-template-columns:minmax(3rem,8rem) 1fr minmax(5rem,auto);align-items:center;gap:.75rem;margin:.8rem 0}.bar-track{position:relative;height:1.2rem;background:linear-gradient(90deg,transparent calc(50% - 1px),#a9c8ed calc(50% - 1px),#a9c8ed calc(50% + 1px),transparent calc(50% + 1px))}.bar{position:absolute;height:100%;min-width:2px;border-radius:999px}.bar.positive{left:50%;background:#1d7cff}.bar.negative{right:50%;background:#ffb000}table{width:100%;border-collapse:collapse;margin-top:1.5rem}th,td{text-align:right;padding:.65rem;border-bottom:1px solid #245da0}th:first-child{text-align:left}.fallback{margin-top:1rem;color:#a9c8ed}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}@media(max-width:480px){.bar-row{grid-template-columns:1fr}.bar{max-width:50%}}
</style>${highchartsScripts}</head><body><main>
<header><h1>${text(title)}</h1><p>${text(subtitle)}</p><p class="meta">Source: ${text(source)} · Updated: ${text(updatedAt)} · Mode: ${text(mode)}</p></header>
<section class="kpis" aria-label="Key performance indicators">${kpiMarkup}</section>
<section class="panel"><h2>${text(chart.title)}</h2><p id="chart-description">${text(chart.description)}</p>${chartBody}
<div class="fallback"><p>Accessible data table</p><div style="overflow:auto"><table><thead><tr><th scope="col">Series</th>${tableHeader}</tr></thead><tbody>${tableRows}</tbody></table></div></div></section>
</main>${highchartsInit}</body></html>`;

await writeFile(String(options.get('--output')), html, 'utf8');
process.stdout.write(`Created ${options.get('--output')} in ${mode} mode. Validate and visually inspect it before delivery.\n`);
