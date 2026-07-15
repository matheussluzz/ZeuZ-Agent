import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const validator = fileURLToPath(new URL('./validate-vault.mjs', import.meta.url));
const frontmatter = (id, type = 'index') => `---
id: ${id}
type: ${type}
status: verified
aliases: []
tags: []
source: "local fixture"
last_verified: 2026-07-14
sensitivity: internal
related: []
---
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'clio-vault-'));
  await mkdir(join(root, 'Rules'));
  await writeFile(join(root, 'Home.md'), `${frontmatter('home')}\n# Home\n\n- [[Rules/Index]]\n`);
  await writeFile(join(root, 'Rules', 'Index.md'), `${frontmatter('rules-index')}\n# Rules\n\n- [[Rules/refund-window#Scope]]\n`);
  await writeFile(join(root, 'Rules', 'refund-window.md'), `${frontmatter('refund-window', 'rule')}\n# Refund window\n\n## Scope\n\nVerified fixture. ^scope\n`);
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [validator, root, ...args], { encoding: 'utf8' });
}

test('accepts a reachable vault with valid headings and frontmatter', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(root, '--strict', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).pass, true);
});

test('rejects a missing heading and orphan note', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'Rules', 'Index.md'), `${frontmatter('rules-index')}\n# Rules\n\n- [[Rules/refund-window#Missing]]\n`);
  await writeFile(join(root, 'orphan.md'), `${frontmatter('orphan', 'rule')}\n# Orphan\n`);
  const result = run(root, '--json');
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.errors.some((message) => message.includes('missing heading')));
  assert.ok(report.errors.some((message) => message.includes('orphan note')));
});
