#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [path, modeFlag, requestedMode] = process.argv.slice(2);
if (!path || path === '--help' || modeFlag !== '--mode' || !requestedMode) {
  process.stdout.write('Usage: node validate-dashboard.mjs <dashboard.html> --mode offline-basic|highcharts-cdn|highcharts-self-hosted\nStructural/security checks only; this does not prove data correctness, visual quality, accessibility conformance, or license sufficiency.\n');
  process.exit(path === '--help' ? 0 : 2);
}
if (!['offline-basic', 'highcharts-cdn', 'highcharts-self-hosted'].includes(requestedMode)) throw new Error(`Unsupported mode: ${requestedMode}`);

const html = await readFile(path, 'utf8');
const errors = [];
const requirePattern = (pattern, message) => { if (!pattern.test(html)) errors.push(message); };
requirePattern(/^<!doctype html>/i, 'missing HTML doctype');
requirePattern(/<meta charset=["']utf-8["']/i, 'missing UTF-8 charset');
requirePattern(/name=["']viewport["']/i, 'missing viewport metadata');
requirePattern(/http-equiv=["']Content-Security-Policy["']/i, 'missing Content Security Policy');
requirePattern(new RegExp(`data-zeuz-render-mode=["']${requestedMode}["']`, 'i'), 'render mode marker does not match requested mode');
requirePattern(/<h1\b/i, 'missing level-one heading');
requirePattern(/<table\b/i, 'missing accessible data-table fallback');
requirePattern(/Source:/i, 'missing visible source label');
if (/\b(?:eval\s*\(|new\s+Function\s*\(|document\.write\s*\()/i.test(html)) errors.push('dangerous dynamic JavaScript primitive detected');
if (!/fallbackToExportServer\s*:\s*false/.test(html) && requestedMode !== 'offline-basic') errors.push('Highcharts external export fallback is not explicitly disabled');

const external = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["'](https?:\/\/[^"']+)["']/gi)].map((match) => match[1]);
if (requestedMode === 'offline-basic') {
  if (external.length) errors.push(`offline mode contains external assets: ${external.join(', ')}`);
  if (/\bHighcharts\b/i.test(html)) errors.push('offline mode unexpectedly references Highcharts');
} else {
  requirePattern(/name=["']zeuz-highcharts-license-confirmed["']\s+content=["']true["']/i, 'missing recorded Highcharts license assertion');
}
if (requestedMode === 'highcharts-cdn') {
  const allowlist = new Set([
    'https://code.highcharts.com/highcharts.js',
    'https://code.highcharts.com/modules/exporting.js',
    'https://code.highcharts.com/modules/export-data.js',
    'https://code.highcharts.com/modules/accessibility.js',
  ]);
  for (const url of external) if (!allowlist.has(url)) errors.push(`external asset is outside the fixed Highcharts allowlist: ${url}`);
  for (const url of allowlist) if (!external.includes(url)) errors.push(`required Highcharts asset is missing: ${url}`);
}
if (requestedMode === 'highcharts-self-hosted') {
  if (external.length) errors.push(`self-hosted mode contains external assets: ${external.join(', ')}`);
  const localScripts = [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)].map((match) => match[1]).filter((source) => !/^https?:/i.test(source));
  if (localScripts.length !== 1) errors.push('self-hosted mode must reference exactly one reviewed local licensed bundle');
  else {
    const metadata = await stat(resolve(dirname(path), localScripts[0])).catch(() => undefined);
    if (!metadata?.isFile()) errors.push(`self-hosted bundle does not exist beside the dashboard: ${localScripts[0]}`);
  }
}

if (errors.length) {
  for (const error of errors) process.stderr.write(`FAIL: ${error}\n`);
  process.stderr.write('Structural checks only; review rendered behavior, data, accessibility, and licensing separately.\n');
  process.exit(1);
}
process.stdout.write('PASS: dashboard structure and selected mode passed conservative checks. This does not prove data correctness, visual quality, accessibility conformance, or license sufficiency.\n');
