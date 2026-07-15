import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import { loadZeuZEnvironment } from '../src/env.js';

const roots: string[] = [];
const previousInstallDir = process.env.ZEUZ_INSTALL_DIR;
const fixtureName = 'ZEUZ_ENV_SECURITY_FIXTURE';

afterEach(async () => {
  delete process.env[fixtureName];
  if (previousInstallDir === undefined) delete process.env.ZEUZ_INSTALL_DIR;
  else process.env.ZEUZ_INSTALL_DIR = previousInstallDir;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-env-'));
  roots.push(root);
  process.env.ZEUZ_INSTALL_DIR = root;
  return root;
}

test('loads a private regular legacy .env file', async () => {
  const root = await fixtureRoot();
  await writeFile(join(root, '.env'), `${fixtureName}=loaded\n`, { mode: 0o600 });

  loadZeuZEnvironment();

  assert.equal(process.env[fixtureName], 'loaded');
});

test('rejects a legacy .env symlink', async () => {
  const root = await fixtureRoot();
  const target = join(root, 'private-config');
  await writeFile(target, `${fixtureName}=unsafe\n`, { mode: 0o600 });
  await symlink(target, join(root, '.env'));

  assert.throws(() => loadZeuZEnvironment(), /\.env must be a regular file, not a symlink/);
  assert.equal(process.env[fixtureName], undefined);
});

test('rejects group or world-readable legacy .env permissions', { skip: process.platform === 'win32' }, async () => {
  const root = await fixtureRoot();
  await writeFile(join(root, '.env'), `${fixtureName}=unsafe\n`, { mode: 0o644 });

  assert.throws(() => loadZeuZEnvironment(), /chmod 600 \.env/);
  assert.equal(process.env[fixtureName], undefined);
});
