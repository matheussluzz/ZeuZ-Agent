import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const builder = fileURLToPath(new URL('./build-dashboard.mjs', import.meta.url));
const validator = fileURLToPath(new URL('./validate-dashboard.mjs', import.meta.url));
const sample = fileURLToPath(new URL('../assets/sample-data.json', import.meta.url));
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('builds and validates offline, licensed CDN, and self-hosted modes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hefesto-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ['offline-basic', 'highcharts-cdn']) {
    const output = join(root, `${mode}.html`);
    const buildArgs = ['--input', sample, '--output', output, '--mode', mode];
    if (mode === 'highcharts-cdn') buildArgs.push('--license-confirmed');
    const built = run(builder, buildArgs);
    assert.equal(built.status, 0, built.stderr);
    const validated = run(validator, [output, '--mode', mode]);
    assert.equal(validated.status, 0, validated.stderr);
    assert.match(await readFile(output, 'utf8'), new RegExp(`data-zeuz-render-mode="${mode}"`));
  }
  const bundle = join(root, 'licensed-bundle.js');
  const selfHostedOutput = join(root, 'highcharts-self-hosted.html');
  await writeFile(bundle, '/* synthetic test bundle; runtime modules are tested separately */');
  const selfHosted = run(builder, ['--input', sample, '--output', selfHostedOutput, '--mode', 'highcharts-self-hosted', '--license-confirmed', '--script', './licensed-bundle.js']);
  assert.equal(selfHosted.status, 0, selfHosted.stderr);
  assert.equal(run(validator, [selfHostedOutput, '--mode', 'highcharts-self-hosted']).status, 0);
  const refused = run(builder, ['--input', sample, '--output', join(root, 'unlicensed.html'), '--mode', 'highcharts-cdn']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /license-confirmed/i);
});
