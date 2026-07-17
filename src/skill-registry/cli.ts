import { installRoot } from '../env.js';
import { buildCatalogIndex, catalogPaths, loadCatalogIndex, reconcileBundleLock, writeCatalogIndex } from './index.js';
import { applyValidation } from './validator.js';
import { SkillRegistryError } from './errors.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SkillCommandResult {
  output: string;
  exitCode: number;
}

export async function runSkillCommand(argv: string[], root = installRoot()): Promise<SkillCommandResult> {
  const [command, ...rest] = argv;
  if (!command) {
    return { exitCode: 1, output: 'Usage: zeuz skill list|status|validate|install|update|remove|sync|check [args]' };
  }

  try {
    switch (command) {
      case 'list': {
        const index = await loadCatalogIndex(root);
        const lines = index.skills.map((skill) => `${skill.name.padEnd(16)} ${skill.id.padEnd(40)} trust=${skill.zeuz.trust} enabled=${skill.zeuz.enablement}`);
        return { exitCode: 0, output: lines.join('\n') || 'No skills indexed.' };
      }
      case 'status': {
        const index = await loadCatalogIndex(root);
        const lines = [`skills=${index.skills.length}`, `bundles=${index.bundles.length}`];
        for (const bundle of index.bundles) {
          lines.push(`${bundle.bundleId}: revision=${bundle.revision} skills=${bundle.skillCount} excluded=${bundle.excludedCount} digest=${bundle.inventoryDigest.slice(0, 12)}`);
        }
        return { exitCode: 0, output: lines.join('\n') };
      }
      case 'validate': {
        const index = applyValidation(await buildCatalogIndex(root));
        await writeCatalogIndex(index, root);
        const errors = index.skills.flatMap((skill) => skill.validation?.errors ?? []);
        return { exitCode: errors.length === 0 ? 0 : 1, output: errors.length === 0 ? 'Catalog validation passed.' : errors.join('\n') };
      }
      case 'sync':
      case 'check': {
        const bundleId = rest[0];
        if (!bundleId) return { exitCode: 1, output: `${command} requires bundle id (bmad|nvidia).` };
        const { execFileSync } = await import('node:child_process');
        const output = execFileSync('node', [join(root, 'scripts/sync-skill-bundle.mjs'), bundleId, command === 'check' ? 'check' : 'apply'], { cwd: root, encoding: 'utf8' });
        if (command === 'sync') {
          const index = applyValidation(await buildCatalogIndex(root));
          await writeCatalogIndex(index, root);
        }
        return { exitCode: 0, output: output.trim() };
      }
      case 'install':
      case 'update': {
        const skillId = rest[0];
        if (!skillId) return { exitCode: 1, output: `${command} requires a catalog skill id.` };
        const index = await loadCatalogIndex(root);
        const skill = index.skills.find((candidate) => candidate.id === skillId || candidate.name === skillId);
        if (!skill) return { exitCode: 1, output: `Unknown skill id: ${skillId}` };
        if (skill.zeuz.trust === 'quarantined') {
          return { exitCode: 1, output: `Skill ${skill.id} remains quarantined until explicit reviewed enablement.` };
        }
        return { exitCode: 0, output: `${command} verified metadata for ${skill.id}; no filesystem mutation required in local snapshot mode.` };
      }
      case 'remove': {
        const skillId = rest[0];
        if (!skillId) return { exitCode: 1, output: 'remove requires a catalog skill id.' };
        const index = await loadCatalogIndex(root);
        const dependents = index.skills.filter((skill) => (skill.zeuz.dependencies ?? []).includes(skillId) || (skill.zeuz.dependencies ?? []).some((dep) => skillId.endsWith(dep)));
        if (dependents.length > 0) {
          return { exitCode: 1, output: `Remove blocked by dependents: ${dependents.map((skill) => skill.id).join(', ')}` };
        }
        return { exitCode: 0, output: `Remove preflight passed for ${skillId}. Bundle snapshots remain restorable via lock rollback.` };
      }
      default:
        return { exitCode: 1, output: `Unknown skill command: ${command}` };
    }
  } catch (error) {
    if (error instanceof SkillRegistryError) return { exitCode: 1, output: `${error.code}: ${error.message}` };
    return { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
  }
}

export async function reconcileInstalledBundles(root = installRoot()): Promise<string[]> {
  const { lockRoot, bundleRoot } = catalogPaths(root);
  const mismatches: string[] = [];
  for (const bundleId of ['bmad', 'nvidia']) {
    const lockPath = join(lockRoot, `${bundleId}.lock.json`);
    try {
      const lock = JSON.parse(await readFile(lockPath, 'utf8'));
      const index = await loadCatalogIndex(root);
      const discovered = index.skills.filter((skill) => skill.source.bundleId === bundleId).map((skill) => skill.id).sort();
      mismatches.push(...reconcileBundleLock(lock, discovered).map((item) => `${bundleId}:${item}`));
      if (!discovered.length && lock.importedSkillTotal > 0) mismatches.push(`${bundleId}:bundle-missing`);
    } catch {
      mismatches.push(`${bundleId}:lock-missing`);
    }
  }
  return mismatches;
}
