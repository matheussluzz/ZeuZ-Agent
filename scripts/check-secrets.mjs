#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => file !== 'scripts/check-secrets.mjs');

const signatures = [
  { name: 'NVIDIA API key', pattern: /nvapi-[A-Za-z0-9_-]{16,}/g },
  { name: 'OpenAI API key', pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'GitHub token', pattern: /gh[opusr]_[A-Za-z0-9]{20,}/g },
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'Private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'Generic assigned secret', pattern: /(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET)\s*=\s*["']?(?!<|your-|example|replace|\$)[A-Za-z0-9_./+=-]{18,}/gi },
];

const findings = [];

for (const file of tracked) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const signature of signatures) {
    signature.pattern.lastIndex = 0;
    if (signature.pattern.test(content)) findings.push(`${file}: ${signature.name}`);
  }
}

if (findings.length > 0) {
  console.error('Potential secrets found in tracked files:');
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}

console.log(`Secret scan passed (${tracked.length} tracked files).`);
