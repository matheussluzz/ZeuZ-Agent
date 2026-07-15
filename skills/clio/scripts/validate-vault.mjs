#!/usr/bin/env node
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const [requested, ...flags] = process.argv.slice(2);
if (!requested || requested === '--help') {
  process.stdout.write('Usage: node validate-vault.mjs <vault-path> [--strict] [--json]\nConservative repository checks only; passing does not prove factual accuracy, privacy, link meaning, or Obsidian runtime behavior.\n');
  process.exit(requested === '--help' ? 0 : 2);
}
const strict = flags.includes('--strict');
const jsonOutput = flags.includes('--json');
const root = await realpath(resolve(requested));
const files = [];
const errors = [];
const warnings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.obsidian' || entry.name === '.DS_Store') continue;
    const path = resolve(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      let target;
      try { target = await realpath(path); } catch { errors.push(`broken symlink: ${relative(root, path)}`); continue; }
      const relation = relative(root, target);
      if (relation.startsWith(`..${sep}`) || relation === '..' || isAbsolute(relation)) errors.push(`symlink escapes vault: ${relative(root, path)}`);
      else warnings.push(`internal symlink skipped: ${relative(root, path)}`);
      continue;
    }
    if (metadata.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.md')) files.push(path);
  }
}

await walk(root);
const byKey = new Map();
const lowerKeys = new Map();
const byBasename = new Map();
const documents = new Map();
const aliases = new Map();
const ids = new Map();
const requiredProperties = ['id', 'type', 'status', 'aliases', 'tags', 'source', 'last_verified', 'sensitivity', 'related'];

function parseScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { properties: {}, bodyStart: 0, present: false };
  const end = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (end < 0) return { properties: {}, bodyStart: 0, present: false, malformed: true };
  const properties = {};
  let currentList;
  for (const line of lines.slice(1, end + 1)) {
    const item = line.match(/^\s*-\s+(.+)$/);
    if (item && currentList) { properties[currentList].push(parseScalar(item[1])); continue; }
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    const [, key, raw] = field;
    currentList = undefined;
    if (raw.trim() === '') {
      if (['aliases', 'tags', 'related'].includes(key)) {
        properties[key] = [];
        currentList = key;
      } else properties[key] = '';
      continue;
    }
    if (raw.trim().startsWith('[') && raw.trim().endsWith(']')) {
      const inner = raw.trim().slice(1, -1).trim();
      properties[key] = inner ? inner.split(',').map(parseScalar) : [];
    } else properties[key] = parseScalar(raw);
    if (Array.isArray(properties[key])) currentList = key;
  }
  return { properties, bodyStart: end + 2, present: true };
}

function stripFormatting(value) {
  return value.replace(/`([^`]+)`/g, '$1').replace(/[*_~]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
}

function withoutCode(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

for (const path of files) {
  const key = relative(root, path).split(sep).join('/').replace(/\.md$/, '');
  if (byKey.has(key)) errors.push(`duplicate canonical path: ${key}`);
  byKey.set(key, path);
  const lower = key.toLocaleLowerCase('en-US');
  const caseMatches = lowerKeys.get(lower) ?? [];
  caseMatches.push(key);
  lowerKeys.set(lower, caseMatches);
  const base = basename(key);
  const matches = byBasename.get(base) ?? [];
  matches.push(key);
  byBasename.set(base, matches);

  const content = await readFile(path, 'utf8');
  const frontmatter = parseFrontmatter(content);
  const lines = content.split(/\r?\n/);
  const headings = new Map();
  const blocks = new Set();
  for (const [index, line] of lines.entries()) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) headings.set(stripFormatting(heading[1]).toLocaleLowerCase('en-US'), index + 1);
    const block = line.match(/(?:^|\s)\^([A-Za-z0-9-]+)\s*$/);
    if (block) blocks.add(block[1]);
  }
  documents.set(key, { content, lines, headings, blocks, frontmatter });

  const template = key.toLocaleLowerCase('en-US').startsWith('templates/');
  if (frontmatter.malformed) errors.push(`${key}: unterminated frontmatter`);
  if (!template) {
    for (const property of requiredProperties) if (!(property in frontmatter.properties)) warnings.push(`${key}: missing frontmatter property ${property}`);
  }
  const { id, type, status, sensitivity, last_verified: verified, aliases: noteAliases } = frontmatter.properties;
  if (typeof id === 'string' && id) {
    const normalizedId = id.toLocaleLowerCase('en-US');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) warnings.push(`${key}: id should be a stable lowercase slug`);
    if (ids.has(normalizedId)) errors.push(`${key}: duplicate id ${id} also used by ${ids.get(normalizedId)}`);
    else ids.set(normalizedId, key);
  }
  if (type && !['glossary', 'schema', 'rule', 'source', 'decision', 'index'].includes(type)) errors.push(`${key}: invalid type ${type}`);
  if (status && !['draft', 'verified', 'deprecated'].includes(status)) errors.push(`${key}: invalid status ${status}`);
  if (sensitivity && !['public', 'internal', 'confidential'].includes(sensitivity)) errors.push(`${key}: invalid sensitivity ${sensitivity}`);
  if (verified && !/^\d{4}-\d{2}-\d{2}$/.test(verified)) errors.push(`${key}: last_verified must be YYYY-MM-DD or empty`);
  if (noteAliases !== undefined && !Array.isArray(noteAliases)) errors.push(`${key}: aliases must be a list`);
  for (const alias of Array.isArray(noteAliases) ? noteAliases : []) {
    const aliasKey = alias.toLocaleLowerCase('en-US');
    const aliasMatches = aliases.get(aliasKey) ?? [];
    aliasMatches.push(key);
    aliases.set(aliasKey, aliasMatches);
  }
  const secretPatterns = [
    /\bnvapi-[A-Za-z0-9_-]{16,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  if (secretPatterns.some((pattern) => pattern.test(content))) errors.push(`${key}: probable credential/private key detected; remove and rotate it`);
}

for (const [lower, matches] of lowerKeys) if (matches.length > 1) errors.push(`case-colliding paths: ${matches.join(', ')} (${lower})`);
for (const [alias, matches] of aliases) if (matches.length > 1) errors.push(`ambiguous alias ${alias}: ${matches.join(', ')}`);
for (const [alias, aliasMatches] of aliases) {
  const canonicalMatches = [...byKey.keys()].filter((key) => basename(key).toLocaleLowerCase('en-US') === alias);
  const combined = [...new Set([...aliasMatches, ...canonicalMatches])];
  if (combined.length > 1) errors.push(`alias collides with a canonical basename ${alias}: ${combined.join(', ')}`);
}

const graph = new Map([...byKey.keys()].map((key) => [key, new Set()]));
const linkPattern = /!?\[\[([^\]]+)\]\]/g;

function exactOrCase(candidate) {
  if (byKey.has(candidate)) return { key: candidate };
  const caseMatches = lowerKeys.get(candidate.toLocaleLowerCase('en-US')) ?? [];
  if (caseMatches.length === 1) return { error: `case mismatch (expected ${caseMatches[0]})` };
  if (caseMatches.length > 1) return { error: `case-ambiguous target (${caseMatches.join(', ')})` };
  return undefined;
}

function resolveTarget(sourceKey, rawTarget) {
  const destination = rawTarget.split('|', 1)[0].trim();
  const hashIndex = destination.indexOf('#');
  const rawPath = (hashIndex >= 0 ? destination.slice(0, hashIndex) : destination).trim().replace(/\.md$/i, '');
  const fragment = hashIndex >= 0 ? destination.slice(hashIndex + 1).trim() : '';
  if (!rawPath && fragment) return { key: sourceKey, fragment };
  if (!rawPath || /^(?:https?:|mailto:)/i.test(rawPath)) return undefined;
  if (rawPath.startsWith('/') || rawPath.split('/').includes('..')) return { error: 'path escape' };
  const normalized = rawPath.replace(/^\.\//, '');
  const sourceRelative = dirname(sourceKey) === '.' ? normalized : `${dirname(sourceKey)}/${normalized}`;
  for (const candidate of [normalized, sourceRelative]) {
    const match = exactOrCase(candidate);
    if (match) return { ...match, fragment };
  }
  if (!normalized.includes('/')) {
    const baseMatches = byBasename.get(normalized) ?? [];
    if (baseMatches.length === 1) return { key: baseMatches[0], fragment };
    if (baseMatches.length > 1) return { error: `ambiguous basename (${baseMatches.join(', ')})` };
    const aliasMatches = aliases.get(normalized.toLocaleLowerCase('en-US')) ?? [];
    if (aliasMatches.length === 1) return { key: aliasMatches[0], fragment };
    if (aliasMatches.length > 1) return { error: `ambiguous alias (${aliasMatches.join(', ')})` };
  }
  return { error: 'broken target' };
}

for (const [sourceKey, document] of documents) {
  const searchable = withoutCode(document.content);
  for (const match of searchable.matchAll(linkPattern)) {
    const resolved = resolveTarget(sourceKey, match[1] ?? '');
    if (!resolved) continue;
    if (resolved.error) { errors.push(`${sourceKey}: ${resolved.error}: [[${match[1]}]]`); continue; }
    graph.get(sourceKey)?.add(resolved.key);
    if (resolved.fragment) {
      const target = documents.get(resolved.key);
      if (resolved.fragment.startsWith('^')) {
        if (!target?.blocks.has(resolved.fragment.slice(1))) errors.push(`${sourceKey}: missing block ${resolved.fragment} in ${resolved.key}`);
      } else if (!target?.headings.has(stripFormatting(resolved.fragment).toLocaleLowerCase('en-US'))) errors.push(`${sourceKey}: missing heading #${resolved.fragment} in ${resolved.key}`);
    }
  }
}

if (!byKey.has('Home')) errors.push('Home.md is missing');
else {
  const reachable = new Set(['Home']);
  const queue = ['Home'];
  while (queue.length) {
    const current = queue.shift();
    for (const target of graph.get(current) ?? []) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }
  for (const key of byKey.keys()) if (!reachable.has(key) && !key.toLocaleLowerCase('en-US').startsWith('templates/')) errors.push(`orphan note: ${key}.md`);
}

if (strict) errors.push(...warnings.splice(0));
const result = {
  pass: errors.length === 0,
  notes: files.length,
  errors,
  warnings,
  disclaimer: 'Repository checks only; passing does not prove factual accuracy, privacy, semantic link quality, source authority, or Obsidian runtime behavior.',
};
if (jsonOutput) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  for (const warning of warnings) process.stderr.write(`WARN: ${warning}\n`);
  for (const error of errors) process.stderr.write(`FAIL: ${error}\n`);
  if (result.pass) process.stdout.write(`PASS: ${files.length} notes passed conservative vault checks${warnings.length ? ` with ${warnings.length} warning(s)` : ''}. ${result.disclaimer}\n`);
  else process.stderr.write(`${result.disclaimer}\n`);
}
process.exit(result.pass ? 0 : 1);
