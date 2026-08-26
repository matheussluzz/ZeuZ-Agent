import { execFileSync } from 'node:child_process';
import { installRoot, sanitizedChildEnvironment } from '../env.js';
import { buildCatalogIndex, collectBundleIntegrityMismatches, loadCatalogIndex, writeCatalogIndex } from './index.js';
import { effectiveCatalogIndex, installSkill, removeSkill, updateSkill } from './installer.js';
import { applyValidation } from './validator.js';
import { SkillRegistryError } from './errors.js';
import { join } from 'node:path';

export interface SkillCommandResult {
  output: string;
  exitCode: number;
}

export interface SkillCommandRuntime {
  execFileSync?: typeof execFileSync;
}

export async function runSkillCommand(argv: string[], root = installRoot(), runtime: SkillCommandRuntime = {}): Promise<SkillCommandResult> {
  const [command, ...rest] = argv;
  if (!command) {
    return { exitCode: 1, output: 'Usage: zeuz skill list|status|validate|install|update|remove|sync|check [args]' };
  }

  try {
    switch (command) {
      case 'list': {
        const index = await effectiveCatalogIndex(root);
        const lines = index.skills.map((skill) => `${skill.name.padEnd(16)} ${skill.id.padEnd(40)} trust=${skill.zeuz.trust} enabled=${skill.zeuz.enablement}`);
        return { exitCode: 0, output: lines.join('\n') || 'No skills indexed.' };
      }
      case 'status': {
        const index = await effectiveCatalogIndex(root);
        const lines = [`skills=${index.skills.length}`, `bundles=${index.bundles.length}`];
        for (const bundle of index.bundles) {
          lines.push(`${bundle.bundleId}: revision=${bundle.revision} skills=${bundle.skillCount} excluded=${bundle.excludedCount} digest=${bundle.inventoryDigest.slice(0, 12)}`);
        }
        return { exitCode: 0, output: lines.join('\n') };
      }
      case 'validate': {
        const writeIndex = rest.includes('--write-index');
        const index = applyValidation(await buildCatalogIndex(root));
        const errors = index.skills.flatMap((skill) => skill.validation?.errors ?? []);
        if (writeIndex) await writeCatalogIndex(index, root);
        const suffix = writeIndex ? ' Index written.' : ' Index not written (pass --write-index to persist).';
        return { exitCode: errors.length === 0 ? 0 : 1, output: (errors.length === 0 ? 'Catalog validation passed.' : errors.join('\n')) + suffix };
      }
      case 'sync':
      case 'check': {
        const bundleId = rest[0];
        if (!bundleId) return { exitCode: 1, output: `${command} requires bundle id (bmad|nvidia).` };
        const execute = runtime.execFileSync ?? execFileSync;
        const output = execute('node', [join(root, 'scripts/sync-skill-bundle.mjs'), bundleId, command === 'check' ? 'check' : 'apply'], {
          cwd: root,
          encoding: 'utf8',
          env: sanitizedChildEnvironment(),
        });
        if (command === 'sync') {
          const index = applyValidation(await buildCatalogIndex(root, new Date().toISOString()));
          await writeCatalogIndex(index, root);
        }
        return { exitCode: 0, output: output.trim() };
      }
      case 'install': {
        const skillId = rest.find((arg) => !arg.startsWith('--'));
        const enable = rest.includes('--enable');
        if (!skillId) return { exitCode: 1, output: 'install requires a catalog skill id.' };
        return { exitCode: 0, output: await installSkill(root, skillId, { enable }) };
      }
      case 'update': {
        const skillId = rest[0];
        if (!skillId) return { exitCode: 1, output: 'update requires a catalog skill id.' };
        return { exitCode: 0, output: await updateSkill(root, skillId) };
      }
      case 'remove': {
        const skillId = rest.find((arg) => !arg.startsWith('--'));
        const force = rest.includes('--force');
        if (!skillId) return { exitCode: 1, output: 'remove requires a catalog skill id.' };
        return { exitCode: 0, output: await removeSkill(root, skillId, { force }) };
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
  return collectBundleIntegrityMismatches(root);
}
