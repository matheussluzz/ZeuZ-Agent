#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const [sourcePath, targetPath, ...flags] = process.argv.slice(2);
if (!sourcePath || !targetPath || sourcePath === '--help') {
  process.stdout.write('Usage: node check-invariants.mjs <source.txt> <translation.txt> [--json]\nConservative lexical check only; it does not prove semantic equivalence or comprehension.\n');
  process.exit(sourcePath === '--help' ? 0 : 2);
}

const [source, target] = await Promise.all([
  readFile(sourcePath, 'utf8'),
  readFile(targetPath, 'utf8'),
]);

const patterns = {
  numeric: /(?<![\p{L}\p{N}_])[-+]?\p{Sc}?\d[\d.,:/-]*(?:\s?(?:%|bps?|ms|s|sec(?:onds?)?|min(?:utes?)?|h(?:ours?)?|days?|weeks?|months?|years?|KB|MB|GB|TB|USD|EUR|BRL))?/giu,
  acronym: /\b[A-Z][A-Z0-9-]{1,11}\b/g,
  url: /https?:\/\/[^\s)\]>]+/giu,
};
const highRiskLanguage = /\b(?:must|shall|should|may|might|will|cannot|can't|never|not|required|prohibited|estimated|approximately|at least|at most|deve|deverá|deveria|pode|poderá|não|nunca|obrigatório|proibido|estimado|aproximadamente|no mínimo|no máximo)\b/giu;

function normalize(value) {
  return value.normalize('NFKC').replace(/[\u2018\u2019]/g, "'").toLocaleLowerCase('en-US');
}

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

const targetNormalized = normalize(target);
const missing = [];
for (const [kind, pattern] of Object.entries(patterns)) {
  const unique = [...new Set(occurrences(source, pattern))];
  for (const token of unique) {
    if (!targetNormalized.includes(normalize(token))) missing.push({ kind, token });
  }
}

const result = {
  pass: missing.length === 0,
  disclaimer: 'Lexical backstop only; modality/negation still require manual meaning-contract review, and passing does not prove semantic equivalence, legal adequacy, or reader comprehension.',
  missing,
  manualReview: [...new Set(occurrences(source, highRiskLanguage))],
};

if (flags.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else if (result.pass) {
  if (result.manualReview.length) process.stderr.write(`REVIEW modality/negation: ${result.manualReview.join(', ')}\n`);
  process.stdout.write(`PASS: no tracked lexical invariant disappeared. ${result.disclaimer}\n`);
}
else {
  for (const item of missing) process.stderr.write(`MISSING ${item.kind}: ${item.token}\n`);
  process.stderr.write(`${result.disclaimer}\n`);
}

process.exit(result.pass ? 0 : 1);
