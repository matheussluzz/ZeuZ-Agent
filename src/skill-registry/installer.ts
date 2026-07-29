import { installRoot } from '../env.js';
import { SkillRegistryError } from './errors.js';
import { loadCatalogIndex } from './index.js';
import { applyInstallOverlay, mutateInstallState, readInstallState, type InstallRecord } from './install-state.js';
import type { CatalogSkillRecord, EnablementState } from './types.js';

function findSkill(index: Awaited<ReturnType<typeof loadCatalogIndex>>, skillId: string): CatalogSkillRecord | undefined {
  return index.skills.find((candidate) => candidate.id === skillId || candidate.name === skillId);
}

export async function installSkill(root: string, skillId: string, options: { enable?: boolean } = {}): Promise<string> {
  const index = await loadCatalogIndex(root);
  const skill = findSkill(index, skillId);
  if (!skill) throw new SkillRegistryError('SKILL_NOT_FOUND', `Unknown skill id: ${skillId}`);
  if (skill.zeuz.trust === 'quarantined' || skill.zeuz.trust === 'invalid') {
    throw new SkillRegistryError('SKILL_QUARANTINED', `Skill ${skill.id} remains ${skill.zeuz.trust}; explicit reviewed enablement is required before install.`);
  }
  const enablement: EnablementState = options.enable ? 'enabled' : 'disabled';
  if (options.enable && skill.zeuz.trust !== 'enabled') {
    throw new SkillRegistryError('SKILL_ENABLE_BLOCKED', `Cannot enable ${skill.id} while trust is ${skill.zeuz.trust}; only trust=enabled skills accept --enable.`);
  }
  const record: InstallRecord = {
    skillId: skill.id,
    revision: skill.source.revision,
    installedAt: new Date().toISOString(),
    trust: skill.zeuz.trust,
    enablement,
  };
  await mutateInstallState(root, (state) => ({
    ...state,
    installs: { ...state.installs, [skill.id]: record },
  }));
  return `Installed ${skill.id} at revision ${skill.source.revision} (enablement=${enablement}).`;
}

export interface UpdateSkillHooks {
  beforeStateMutation?: () => Promise<void>;
}

export async function updateSkill(root: string, skillId: string, hooks: UpdateSkillHooks = {}): Promise<string> {
  const index = await loadCatalogIndex(root);
  const skill = findSkill(index, skillId);
  if (!skill) throw new SkillRegistryError('SKILL_NOT_FOUND', `Unknown skill id: ${skillId}`);
  await hooks.beforeStateMutation?.();
  let previousRevision: string | undefined;
  let changed = false;
  await mutateInstallState(root, (draft) => {
    const current = draft.installs[skill.id];
    if (!current) throw new SkillRegistryError('SKILL_NOT_INSTALLED', `Skill ${skill.id} is not installed.`);
    previousRevision = current.revision;
    if (current.revision === skill.source.revision) return draft;
    changed = true;
    return {
      ...draft,
      installs: {
        ...draft.installs,
        [skill.id]: {
          ...current,
          revision: skill.source.revision,
          installedAt: new Date().toISOString(),
          trust: skill.zeuz.trust,
          enablement: skill.zeuz.trust === 'enabled' ? current.enablement : 'disabled',
        },
      },
    };
  });
  if (!changed) return `Skill ${skill.id} already at revision ${skill.source.revision}; no update required.`;
  return `Updated ${skill.id} from ${previousRevision} to ${skill.source.revision}.`;
}

export async function removeSkill(root: string, skillId: string, options: { force?: boolean } = {}): Promise<string> {
  const index = await loadCatalogIndex(root);
  const skill = findSkill(index, skillId);
  if (!skill) throw new SkillRegistryError('SKILL_NOT_FOUND', `Unknown skill id: ${skillId}`);
  const dependents = index.skills.filter((candidate) => (candidate.zeuz.dependencies ?? []).includes(skill.name));
  if (dependents.length > 0 && !options.force) {
    throw new SkillRegistryError('SKILL_REMOVE_BLOCKED', `Remove blocked by dependents: ${dependents.map((item) => item.id).join(', ')}`);
  }
  await mutateInstallState(root, (state) => {
    if (!state.installs[skill.id]) throw new SkillRegistryError('SKILL_NOT_INSTALLED', `Skill ${skill.id} is not installed.`);
    const next = { ...state.installs };
    delete next[skill.id];
    return { ...state, installs: next };
  });
  return `Removed install record for ${skill.id}. Bundle snapshot remains restorable via lock rollback.`;
}

export { applyInstallOverlay, readInstallState, resetInstallState } from './install-state.js';

export async function effectiveCatalogIndex(root = installRoot()) {
  const index = await loadCatalogIndex(root);
  const state = await readInstallState(root);
  return applyInstallOverlay(index, state);
}
