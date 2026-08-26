import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildCatalogIndex, loadCatalogIndex, verifyInstalledBundleBytes, writeCatalogIndex } from '../src/skill-registry/index.js';
import { applyInstallOverlay, mutateInstallState, overlaySkillInstallState, readInstallState, resetInstallState } from '../src/skill-registry/install-state.js';
import { installSkill, removeSkill, updateSkill } from '../src/skill-registry/installer.js';
import { acquireLeaseLock } from '../src/skill-registry/lease-lock.js';
import { assertPathComponentsNotSymlinks, validateSkillPaths } from '../src/skill-registry/paths.js';
import { runSkillCommand } from '../src/skill-registry/cli.js';
import { PortableSkillRegistry } from '../src/skill-registry/registry.js';
import { resolveActivation } from '../src/skill-registry/resolver.js';

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('intermediate directory symlink escape is rejected before SKILL.md load', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'zeuz-symlink-'));
  const root = join(parent, 'install');
  const external = join(parent, 'external');
  await mkdir(join(root, 'skills'), { recursive: true });
  await mkdir(join(external, 'evil'), { recursive: true });
  await writeFile(join(external, 'evil', 'SKILL.md'), '---\nname: evil\ndescription: x\n---\n\nEXTERNAL_INSTRUCTION\n');
  await symlink(external, join(root, 'skills', 'link'));
  const record = {
    schemaVersion: 1,
    id: 'zeuz/pantheon/evil@0.1.0',
    name: 'evil',
    description: 'x',
    rootRel: 'skills/link/evil',
    skillMdRel: 'skills/link/evil/SKILL.md',
    source: { kind: 'pantheon' as const, namespace: 'zeuz/pantheon', canonicalUrl: 'local', revision: 'x' },
    portable: { name: 'evil', description: 'x' },
    zeuz: {
      namespace: 'zeuz/pantheon',
      version: '0.1.0',
      trust: 'enabled' as const,
      enablement: 'enabled' as const,
      networkPolicy: 'offline' as const,
      triggers: [],
      dependencies: [],
      conflicts: [],
      contextBudgetBytes: 40_000,
    },
    inventoryDigest: 'x',
    fileCount: 1,
    totalBytes: 1,
  };
  await assert.rejects(() => validateSkillPaths(root, record), (error: unknown) => (error as { code?: string }).code === 'SYMLINK_REJECTED');
  await assert.rejects(() => assertPathComponentsNotSymlinks(root, join(root, 'skills/link/evil/SKILL.md')), (error: unknown) => (error as { code?: string }).code === 'SYMLINK_REJECTED');
  await rm(parent, { recursive: true, force: true });
});

test('stale install record cannot re-enable invalid catalog revision', () => {
  const skill = {
    schemaVersion: 1,
    id: 'zeuz/pantheon/medusa@0.1.0',
    name: 'medusa',
    description: 'x',
    rootRel: 'skills/medusa',
    skillMdRel: 'skills/medusa/SKILL.md',
    source: { kind: 'pantheon' as const, namespace: 'zeuz/pantheon', canonicalUrl: 'local', revision: 'new' },
    portable: { name: 'medusa', description: 'x' },
    zeuz: {
      namespace: 'zeuz/pantheon',
      version: '0.1.0',
      trust: 'invalid' as const,
      enablement: 'disabled' as const,
      networkPolicy: 'offline' as const,
      triggers: ['medusa'],
      dependencies: [],
      conflicts: [],
      contextBudgetBytes: 40_000,
    },
    inventoryDigest: 'x',
    fileCount: 1,
    totalBytes: 1,
  };
  const overlaid = overlaySkillInstallState(skill, {
    skillId: skill.id,
    revision: 'old',
    installedAt: '2026-01-01T00:00:00.000Z',
    trust: 'enabled',
    enablement: 'enabled',
  });
  assert.equal(overlaid.zeuz.enablement, 'disabled');
  assert.equal(overlaid.zeuz.trust, 'invalid');
});

test('CLI list matches runtime enablement after install without --enable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-cli-effective-'));
  process.env.ZEUZ_INSTALL_DIR = root;
  try {
    await mkdir(join(root, 'skills', 'medusa'), { recursive: true });
    await writeFile(join(root, 'skills', 'medusa', 'SKILL.md'), '---\nname: medusa\ndescription: review\n---\n\n# Medusa\n');
    await writeFile(join(root, 'skills', 'medusa', 'zeuz.manifest.yaml'), 'namespace: zeuz/pantheon\nversion: "0.1.0"\ntrust: enabled\nenablement: enabled\nnetworkPolicy: offline\ntriggers:\n  - medusa\ndependencies: []\n');
    const installed = await runSkillCommand(['install', 'medusa'], root);
    assert.equal(installed.exitCode, 0);
    const list = await runSkillCommand(['list'], root);
    assert.match(list.output, /enabled=disabled/);
    const context = await new PortableSkillRegistry(root).contextFor('medusa adversarial review');
    assert.equal(context, undefined);
  } finally {
    delete process.env.ZEUZ_INSTALL_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt install state fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-corrupt-state-'));
  process.env.ZEUZ_INSTALL_DIR = root;
  try {
    await mkdir(join(root, 'catalog', 'state'), { recursive: true, mode: 0o700 });
    await chmod(join(root, 'catalog', 'state'), 0o700);
    await writeFile(join(root, 'catalog', 'state', 'installs.json'), '{not-json', { mode: 0o600 });
    await assert.rejects(() => readInstallState(root), (error: unknown) => (error as { code?: string }).code === 'INSTALL_STATE_CORRUPT');
  } finally {
    delete process.env.ZEUZ_INSTALL_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test('abandoned install lock is reclaimed for proven-dead owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-orphan-lock-'));
  process.env.ZEUZ_INSTALL_DIR = root;
  try {
    await mkdir(join(root, 'skills', 'medusa'), { recursive: true });
    await writeFile(join(root, 'skills', 'medusa', 'SKILL.md'), '---\nname: medusa\ndescription: review\n---\n\n# Medusa\n');
    await writeFile(join(root, 'skills', 'medusa', 'zeuz.manifest.yaml'), 'namespace: zeuz/pantheon\nversion: "0.1.0"\ntrust: enabled\nenablement: enabled\nnetworkPolicy: offline\ntriggers: []\ndependencies: []\n');
    await mkdir(join(root, 'catalog', 'state'), { recursive: true, mode: 0o700 });
    await chmod(join(root, 'catalog', 'state'), 0o700);
    await writeFile(join(root, 'catalog', 'state', 'installs.lock'), `${JSON.stringify({
      pid: 9_999_999,
      host: hostname(),
      token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      acquiredAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-01T00:00:01.000Z',
    })}\n`, { mode: 0o600 });
    const installed = await installSkill(root, 'medusa');
    assert.match(installed, /Installed/);
  } finally {
    delete process.env.ZEUZ_INSTALL_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test('expired live-owner install lock is not reclaimed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-live-lock-'));
  process.env.ZEUZ_INSTALL_DIR = root;
  try {
    await mkdir(join(root, 'skills', 'medusa'), { recursive: true });
    await writeFile(join(root, 'skills', 'medusa', 'SKILL.md'), '---\nname: medusa\ndescription: review\n---\n\n# Medusa\n');
    await writeFile(join(root, 'skills', 'medusa', 'zeuz.manifest.yaml'), 'namespace: zeuz/pantheon\nversion: "0.1.0"\ntrust: enabled\nenablement: enabled\nnetworkPolicy: offline\ntriggers: []\ndependencies: []\n');
    await mkdir(join(root, 'catalog', 'state'), { recursive: true, mode: 0o700 });
    await chmod(join(root, 'catalog', 'state'), 0o700);
    await writeFile(join(root, 'catalog', 'state', 'installs.lock'), `${JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      acquiredAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-01T00:00:01.000Z',
    })}\n`, { mode: 0o600 });
    await assert.rejects(() => installSkill(root, 'medusa'), (error: unknown) => (error as { code?: string }).code === 'INSTALL_LOCK_TIMEOUT');
  } finally {
    delete process.env.ZEUZ_INSTALL_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test('symlinked catalog state root is rejected before install writes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'zeuz-state-symlink-'));
  const root = join(parent, 'install');
  const external = join(parent, 'external-state');
  process.env.ZEUZ_INSTALL_DIR = root;
  try {
    await mkdir(join(root, 'skills', 'medusa'), { recursive: true });
    await mkdir(join(root, 'catalog'), { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(root, 'skills', 'medusa', 'SKILL.md'), '---\nname: medusa\ndescription: review\n---\n\n# Medusa\n');
    await writeFile(join(root, 'skills', 'medusa', 'zeuz.manifest.yaml'), 'namespace: zeuz/pantheon\nversion: "0.1.0"\ntrust: enabled\nenablement: enabled\nnetworkPolicy: offline\ntriggers: []\ndependencies: []\n');
    await symlink(external, join(root, 'catalog', 'state'));
    await assert.rejects(() => installSkill(root, 'medusa'), (error: unknown) => (error as { code?: string }).code === 'SYMLINK_REJECTED');
    await assert.rejects(() => access(join(external, 'installs.json')));
  } finally {
    delete process.env.ZEUZ_INSTALL_DIR;
    await rm(parent, { recursive: true, force: true });
  }
});

test('permissive catalog state root is rejected before install writes', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-mode-'));
  process.env.ZEUZ_INSTALL_DIR = root;
  try {
    await mkdir(join(root, 'skills', 'medusa'), { recursive: true });
    await mkdir(join(root, 'catalog', 'state'), { recursive: true });
    await chmod(join(root, 'catalog', 'state'), 0o777);
    await writeFile(join(root, 'skills', 'medusa', 'SKILL.md'), '---\nname: medusa\ndescription: review\n---\n\n# Medusa\n');
    await writeFile(join(root, 'skills', 'medusa', 'zeuz.manifest.yaml'), 'namespace: zeuz/pantheon\nversion: "0.1.0"\ntrust: enabled\nenablement: enabled\nnetworkPolicy: offline\ntriggers: []\ndependencies: []\n');
    await assert.rejects(() => installSkill(root, 'medusa'), (error: unknown) => (error as { code?: string }).code === 'INSTALL_STATE_PERMISSIONS');
  } finally {
    delete process.env.ZEUZ_INSTALL_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test('install state rejects invalid trust and enablement schema values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-schema-'));
  try {
    await mkdir(join(root, 'catalog', 'state'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'catalog', 'state', 'installs.json'), `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      installs: {
        bad: { skillId: 'bad', revision: 'x', installedAt: new Date().toISOString(), trust: 'forged', enablement: 'enabled' },
      },
    })}\n`, { mode: 0o600 });
    await assert.rejects(() => readInstallState(root), (error: unknown) => (error as { code?: string }).code === 'INSTALL_STATE_CORRUPT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadCatalogIndex fails closed on tampered bundle bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-load-integrity-'));
  const bundleId = 'bmad';
  const bundleRoot = join(root, 'catalog', 'bundles', bundleId);
  const content = 'license-body';
  await mkdir(bundleRoot, { recursive: true });
  await mkdir(join(root, 'catalog', 'locks'), { recursive: true });
  await writeFile(join(bundleRoot, 'LICENSE'), content);
  const file = { path: 'LICENSE', size: content.length, sha256: sha256Hex(content) };
  const lock = {
    schemaVersion: 1,
    bundleId,
    sourceUrl: 'local',
    revision: 'deadbeef',
    resolvedAt: '2026-01-01T00:00:00.000Z',
    license: { spdx: 'MIT', files: ['LICENSE'], noticeFiles: [], trademarkFiles: [] },
    inventoryDigest: sha256Hex(`${file.path}\t${file.size}\t${file.sha256}`),
    upstreamDiscoveredTotal: 0,
    upstreamSkillTotal: 0,
    importedSkillTotal: 0,
    excluded: [],
    files: [file],
    skills: [],
  };
  await writeFile(join(root, 'catalog', 'locks', `${bundleId}.lock.json`), `${JSON.stringify(lock, null, 2)}\n`);
  await writeFile(join(bundleRoot, 'LICENSE'), `${content}!`);
  process.env.ZEUZ_INSTALL_DIR = root;
  try {
    await assert.rejects(() => loadCatalogIndex(root), (error: unknown) => (error as { code?: string }).code === 'BUNDLE_INTEGRITY_MISMATCH');
  } finally {
    delete process.env.ZEUZ_INSTALL_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test('loadCatalogIndex fails closed on files absent from the bundle lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-load-extra-file-'));
  const bundleId = 'bmad';
  const bundleRoot = join(root, 'catalog', 'bundles', bundleId);
  const content = 'license-body';
  await mkdir(bundleRoot, { recursive: true });
  await mkdir(join(root, 'catalog', 'locks'), { recursive: true });
  await writeFile(join(bundleRoot, 'LICENSE'), content);
  const file = { path: 'LICENSE', size: content.length, sha256: sha256Hex(content) };
  await writeFile(join(root, 'catalog', 'locks', `${bundleId}.lock.json`), `${JSON.stringify({
    schemaVersion: 1,
    bundleId,
    sourceUrl: 'local',
    revision: 'deadbeef',
    resolvedAt: '2026-01-01T00:00:00.000Z',
    license: { spdx: 'MIT', files: ['LICENSE'], noticeFiles: [], trademarkFiles: [] },
    inventoryDigest: sha256Hex(`${file.path}\t${file.size}\t${file.sha256}`),
    upstreamDiscoveredTotal: 0,
    upstreamSkillTotal: 0,
    importedSkillTotal: 0,
    excluded: [],
    files: [file],
    skills: [],
  }, null, 2)}\n`);
  await writeFile(join(bundleRoot, 'UNLISTED'), 'unexpected');
  try {
    await assert.rejects(() => loadCatalogIndex(root), (error: unknown) => {
      return (error as { code?: string; message?: string }).code === 'BUNDLE_INTEGRITY_MISMATCH'
        && Boolean((error as { message?: string }).message?.includes('unexpected:UNLISTED'));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadCatalogIndex ignores a forged generated cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-index-cache-'));
  try {
    const skillRoot = join(root, 'skills', 'safe');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: safe\ndescription: safe\n---\n\n# Safe\n');
    await writeFile(join(skillRoot, 'zeuz.manifest.yaml'), 'namespace: zeuz/pantheon\nversion: "0.1.0"\ntrust: enabled\nenablement: enabled\nnetworkPolicy: offline\ntriggers:\n  - safe\ndependencies: []\n');
    const index = await buildCatalogIndex(root, '2026-01-01T00:00:00.000Z');
    await writeCatalogIndex(index, root);
    const indexPath = join(root, 'catalog', 'index', 'catalog.index.json');
    const forged = JSON.parse(await readFile(indexPath, 'utf8'));
    forged.skills[0].name = 'forged-cache';
    forged.skills[0].zeuz.triggers = ['forged-cache'];
    await writeFile(indexPath, `${JSON.stringify(forged, null, 2)}\n`);
    const loaded = await loadCatalogIndex(root);
    assert.equal(loaded.skills[0]?.name, 'safe');
    assert.deepEqual(loaded.skills[0]?.zeuz.triggers, ['safe']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stale lease handle cannot release a successor claim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-lease-fence-'));
  const lockPath = join(root, 'install.lock');
  try {
    const first = await acquireLeaseLock(lockPath, 30_000, 200);
    await first.release();
    const second = await acquireLeaseLock(lockPath, 30_000, 200);
    await first.release();
    await assert.rejects(() => acquireLeaseLock(lockPath, 30_000, 50), /Timed out waiting for lease lock/);
    await second.release();
    const third = await acquireLeaseLock(lockPath, 30_000, 200);
    await third.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('install lease claims leave no append-only queue or released records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-claim-cleanup-'));
  const lockPath = join(root, 'installs.lock');
  try {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const handle = await acquireLeaseLock(lockPath, 30_000);
      await handle.release();
    }
    assert.deepEqual(await readdir(`${lockPath}.claims`), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resetInstallState removes a quiescent claim directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-reset-claims-'));
  try {
    await resetInstallState(root);
    await assert.rejects(() => lstat(join(root, 'catalog', 'state', 'installs.lock.claims')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('updateSkill cannot resurrect a record removed before its locked mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-update-race-'));
  try {
    await mkdir(join(root, 'skills', 'medusa'), { recursive: true });
    await writeFile(join(root, 'skills', 'medusa', 'SKILL.md'), '---\nname: medusa\ndescription: review\n---\n\n# Medusa\n');
    await writeFile(join(root, 'skills', 'medusa', 'zeuz.manifest.yaml'), 'namespace: zeuz/pantheon\nversion: "0.1.0"\ntrust: enabled\nenablement: enabled\nnetworkPolicy: offline\ntriggers: []\ndependencies: []\n');
    await installSkill(root, 'medusa');
    await mutateInstallState(root, (state) => ({
      ...state,
      installs: {
        ...state.installs,
        'zeuz/pantheon/medusa@0.1.0': {
          ...state.installs['zeuz/pantheon/medusa@0.1.0']!,
          revision: 'outdated',
        },
      },
    }));
    let releaseUpdate!: () => void;
    let updatePaused!: () => void;
    const paused = new Promise<void>((resolve) => { updatePaused = resolve; });
    const release = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const updating = updateSkill(root, 'medusa', {
      beforeStateMutation: async () => {
        updatePaused();
        await release;
      },
    });
    await paused;
    await removeSkill(root, 'medusa');
    releaseUpdate();
    await assert.rejects(updating, (error: unknown) => (error as { code?: string }).code === 'SKILL_NOT_INSTALLED');
    assert.deepEqual((await readInstallState(root)).installs, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sync promotion copies bundle contents without extra directory level', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'zeuz-sync-promote-'));
  try {
    const source = join(parent, 'source');
    const bundleDir = join(parent, 'catalog', 'bundles', 'probe');
    const lockPath = join(parent, 'catalog', 'locks', 'probe.lock.json');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'marker'), 'ok');
    // @ts-expect-error Production sync is intentionally an import-safe ESM script.
    const { promoteBundleSnapshot } = await import('../scripts/sync-skill-bundle.mjs');
    await promoteBundleSnapshot({
      bundleId: 'probe',
      targetRoot: source,
      bundleDir,
      lockPath,
      lockBody: '{"revision":"new"}\n',
      transactionParent: join(parent, 'transactions'),
      boundaryRoot: parent,
    });
    await access(join(bundleDir, 'marker'));
    await assert.rejects(() => access(join(bundleDir, 'source', 'marker')));
    assert.equal(await readFile(lockPath, 'utf8'), '{"revision":"new"}\n');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('sync transaction restores matching prior bundle and lock after post-commit failure', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'zeuz-sync-rollback-'));
  try {
    const source = join(parent, 'source');
    const bundleDir = join(parent, 'catalog', 'bundles', 'probe');
    const lockPath = join(parent, 'catalog', 'locks', 'probe.lock.json');
    await mkdir(source, { recursive: true });
    await mkdir(bundleDir, { recursive: true });
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(join(source, 'new-marker'), 'new');
    await writeFile(join(bundleDir, 'old-marker'), 'old');
    await writeFile(lockPath, '{"revision":"old"}\n');
    // @ts-expect-error Production sync is intentionally an import-safe ESM script.
    const { promoteBundleSnapshot } = await import('../scripts/sync-skill-bundle.mjs');
    await assert.rejects(() => promoteBundleSnapshot({
      bundleId: 'probe',
      targetRoot: source,
      bundleDir,
      lockPath,
      lockBody: '{"revision":"new"}\n',
      transactionParent: join(parent, 'transactions'),
      boundaryRoot: parent,
      hooks: { afterLockCommit: async () => { throw new Error('injected post-commit failure'); } },
    }), /injected post-commit failure/);
    assert.equal(await readFile(join(bundleDir, 'old-marker'), 'utf8'), 'old');
    await assert.rejects(() => access(join(bundleDir, 'new-marker')));
    assert.equal(await readFile(lockPath, 'utf8'), '{"revision":"old"}\n');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('stale sync lock handle cannot release a successor claim', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'zeuz-sync-lock-fence-'));
  try {
    // @ts-expect-error Production sync is intentionally an import-safe ESM script.
    const { acquireSyncLock, releaseSyncLock } = await import('../scripts/sync-skill-bundle.mjs');
    const first = await acquireSyncLock('probe', parent, 200);
    await releaseSyncLock(first);
    const second = await acquireSyncLock('probe', parent, 200);
    await releaseSyncLock(first);
    await assert.rejects(() => acquireSyncLock('probe', parent, 50), /Timed out waiting for sync lock/);
    await releaseSyncLock(second);
    const third = await acquireSyncLock('probe', parent, 200);
    await releaseSyncLock(third);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('sync lease claims leave no append-only queue or released records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-sync-claim-cleanup-'));
  try {
    // @ts-expect-error Production sync is intentionally an import-safe ESM script.
    const { acquireSyncLock, releaseSyncLock } = await import('../scripts/sync-skill-bundle.mjs');
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const handle = await acquireSyncLock('probe', root);
      await releaseSyncLock(handle);
    }
    assert.deepEqual(await readdir(join(root, 'catalog', '.sync', 'probe.lock.claims')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skill sync subprocess receives a secret-sanitized environment', async () => {
  const secretName = 'ZEUZ_TEST_API_KEY';
  const previous = process.env[secretName];
  process.env[secretName] = `sensitive-${'z'.repeat(24)}`;
  let observedEnvironment: NodeJS.ProcessEnv | undefined;
  try {
    const result = await runSkillCommand(['check', 'bmad'], process.cwd(), {
      execFileSync: ((_file, _args, options) => {
        observedEnvironment = options?.env;
        return '{}';
      }) as typeof execFileSync,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(observedEnvironment?.[secretName], undefined);
    assert.ok(observedEnvironment?.PATH);
  } finally {
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
  }
});

test('sync inventory rejects symlinks instead of silently omitting them', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'zeuz-sync-tree-symlink-'));
  try {
    await writeFile(join(parent, 'target'), 'safe');
    await symlink('target', join(parent, 'link'));
    // @ts-expect-error Production sync is intentionally an import-safe ESM script.
    const { walkFiles } = await import('../scripts/sync-skill-bundle.mjs');
    await assert.rejects(() => walkFiles(parent), /Symlinks are not allowed/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('sync archive preflight rejects symlink entries before extraction', { skip: process.platform === 'win32' }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'zeuz-sync-archive-symlink-'));
  const revision = '1234567890abcdef1234567890abcdef12345678';
  try {
    const archiveRoot = join(parent, `repo-${revision}`);
    await mkdir(join(archiveRoot, 'skills'), { recursive: true });
    await writeFile(join(archiveRoot, 'skills', 'target'), 'safe');
    await symlink('target', join(archiveRoot, 'skills', 'link'));
    const zipPath = join(parent, 'probe.zip');
    execFileSync('zip', ['-y', '-q', '-r', zipPath, `repo-${revision}`], { cwd: parent });
    // @ts-expect-error Production sync is intentionally an import-safe ESM script.
    const { inspectZipArchive } = await import('../scripts/sync-skill-bundle.mjs');
    assert.throws(() => inspectZipArchive(zipPath, revision, ['skills']), /symlink or special-file/i);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('sync extraction excludes an out-of-scope archive symlink', { skip: process.platform === 'win32' }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'zeuz-sync-archive-exclude-'));
  const revision = '1234567890abcdef1234567890abcdef12345678';
  try {
    const archiveRoot = join(parent, `repo-${revision}`);
    await mkdir(join(archiveRoot, 'skills'), { recursive: true });
    await mkdir(join(archiveRoot, 'website'), { recursive: true });
    await writeFile(join(archiveRoot, 'skills', 'SKILL.md'), '# Safe');
    await writeFile(join(archiveRoot, 'website', 'target'), 'outside import scope');
    await symlink('target', join(archiveRoot, 'website', 'link'));
    const zipPath = join(parent, 'probe.zip');
    execFileSync('zip', ['-y', '-q', '-r', zipPath, `repo-${revision}`], { cwd: parent });
    const destination = join(parent, 'extract');
    await mkdir(destination);
    // @ts-expect-error Production sync is intentionally an import-safe ESM script.
    const { extractZip } = await import('../scripts/sync-skill-bundle.mjs');
    await extractZip(zipPath, destination, revision, ['skills']);
    await assert.rejects(() => lstat(join(destination, `repo-${revision}`, 'website', 'link')), { code: 'ENOENT' });
    assert.equal(await readFile(join(destination, `repo-${revision}`, 'skills', 'SKILL.md'), 'utf8'), '# Safe');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('sync imported-content sanitizer redacts secrets and preserves placeholders', async () => {
  // @ts-expect-error Production sync is intentionally an import-safe ESM script.
  const { sanitizeImportedContent } = await import('../scripts/sync-skill-bundle.mjs');
  const sensitiveValue = `sensitive-${'q'.repeat(24)}`;
  const input = `API_KEY=${sensitiveValue}\nACCESS_TOKEN=your-token-here\nCLIENT_SECRET=<replace-me>\n`;
  const output = sanitizeImportedContent(input);
  assert.doesNotMatch(output, new RegExp(sensitiveValue));
  assert.match(output, /API_KEY=<redacted-placeholder>/);
  assert.match(output, /ACCESS_TOKEN=your-token-here/);
  assert.match(output, /CLIENT_SECRET=<replace-me>/);
});

test('verifyInstalledBundleBytes detects tampered bundle files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-bundle-integrity-'));
  const bundleRoot = join(root, 'catalog', 'bundles', 'probe');
  const content = 'license-body';
  await mkdir(bundleRoot, { recursive: true });
  await writeFile(join(bundleRoot, 'LICENSE'), content);
  const file = { path: 'LICENSE', size: content.length, sha256: sha256Hex(content) };
  const lock = {
    schemaVersion: 1,
    bundleId: 'probe',
    sourceUrl: 'local',
    revision: 'deadbeef',
    resolvedAt: '2026-01-01T00:00:00.000Z',
    license: { spdx: 'MIT', files: ['LICENSE'], noticeFiles: [], trademarkFiles: [] },
    inventoryDigest: sha256Hex(`${file.path}\t${file.size}\t${file.sha256}`),
    upstreamDiscoveredTotal: 0,
    upstreamSkillTotal: 0,
    importedSkillTotal: 0,
    excluded: [],
    files: [file],
    skills: [],
  };
  const clean = await verifyInstalledBundleBytes(root, 'probe', lock);
  assert.equal(clean.length, 0);
  await writeFile(join(bundleRoot, 'LICENSE'), `${content}!`);
  const mismatches = await verifyInstalledBundleBytes(root, 'probe', lock);
  assert.ok(mismatches.some((item) => item.startsWith('sha256:') || item === 'inventory-digest'));
  await rm(root, { recursive: true, force: true });
});

test('install overlay with matching revision still blocks invalid trust', async () => {
  const index = await buildCatalogIndex();
  const medusa = index.skills.find((skill) => skill.name === 'medusa');
  assert.ok(medusa);
  const invalid = {
    ...medusa,
    zeuz: { ...medusa.zeuz, trust: 'invalid' as const, enablement: 'disabled' as const },
  };
  const overlaid = applyInstallOverlay({ ...index, skills: [invalid] }, {
    schemaVersion: 1,
    revision: 1,
    installs: {
      [invalid.id]: {
        skillId: invalid.id,
        revision: invalid.source.revision,
        installedAt: '2026-01-01T00:00:00.000Z',
        trust: 'enabled',
        enablement: 'enabled',
      },
    },
  });
  const activation = resolveActivation(overlaid, 'medusa adversarial review');
  assert.equal(activation.ordered.length, 0);
});
