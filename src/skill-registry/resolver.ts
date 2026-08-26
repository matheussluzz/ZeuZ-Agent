import { installRoot } from '../env.js';
import type { ActivationResult, CatalogIndex, CatalogSkillRecord, RoutingReason } from './types.js';
import { DEFAULT_ACTIVATION_BUDGET_BYTES } from './types.js';
import { activationError } from './errors.js';
import { readBoundedFile, skillDirectoryName } from './inventory.js';
import { parseSkillMarkdown } from './parser.js';
import { resolveSkillPaths, validateSkillPaths } from './paths.js';

function findByName(index: CatalogIndex, name: string): CatalogSkillRecord | undefined {
  return index.skills.find((skill) => skill.name === name || skill.id === name || skill.id.includes(`/${name}@`));
}

function matchesTask(skill: CatalogSkillRecord, task: string): boolean {
  for (const pattern of skill.zeuz.triggers ?? []) {
    if (new RegExp(pattern, 'i').test(task)) return true;
  }
  return false;
}

function explicitInvocation(skill: CatalogSkillRecord, task: string): boolean {
  const escapedName = skill.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:^|\\s)/' + escapedName + '\\b', 'i').test(task);
}

function shouldActivate(skill: CatalogSkillRecord, task: string): boolean {
  if (skill.portable.disableModelInvocation === true) return explicitInvocation(skill, task);
  return matchesTask(skill, task);
}

function canEvaluateTrigger(skill: CatalogSkillRecord): boolean {
  return skill.zeuz.enablement !== 'disabled' && skill.zeuz.trust !== 'quarantined' && skill.zeuz.trust !== 'invalid';
}

function rejectReason(skill: CatalogSkillRecord, code: RoutingReason['code'], detail?: string): RoutingReason {
  const reason: RoutingReason = { code, skillId: skill.id };
  if (detail !== undefined) reason.detail = detail;
  return reason;
}

export function resolveActivation(index: CatalogIndex, task: string, budgetBytes = DEFAULT_ACTIVATION_BUDGET_BYTES): {
  ordered: CatalogSkillRecord[];
  reasons: RoutingReason[];
} {
  const reasons: RoutingReason[] = [];
  const selected = new Map<string, CatalogSkillRecord>();
  const queue: CatalogSkillRecord[] = [];

  for (const skill of index.skills) {
    if (canEvaluateTrigger(skill) && shouldActivate(skill, task)) {
      reasons.push({ code: 'trigger', skillId: skill.id });
      queue.push(skill);
    }
  }

  while (queue.length > 0) {
    const skill = queue.shift()!;
    if (selected.has(skill.id)) continue;
    if (skill.zeuz.enablement === 'disabled') {
      reasons.push(rejectReason(skill, 'rejected_disabled'));
      continue;
    }
    if (skill.zeuz.trust === 'quarantined') {
      reasons.push(rejectReason(skill, 'rejected_quarantined'));
      continue;
    }
    if (skill.zeuz.trust === 'invalid') {
      reasons.push(rejectReason(skill, 'rejected_invalid'));
      continue;
    }
    let conflictRejected = false;
    for (const conflictName of skill.zeuz.conflicts ?? []) {
      const conflict = findByName(index, conflictName);
      if (conflict && selected.has(conflict.id)) {
        reasons.push(rejectReason(skill, 'rejected_conflict', conflictName));
        conflictRejected = true;
        break;
      }
    }
    if (conflictRejected) continue;
    selected.set(skill.id, skill);
    for (const depName of skill.zeuz.dependencies ?? []) {
      const dep = findByName(index, depName);
      if (!dep) {
        reasons.push(rejectReason(skill, 'rejected_missing_dependency', depName));
        throw activationError({
          code: 'SKILL_DEPENDENCY_MISSING',
          message: `Missing dependency ${depName} for ${skill.id}.`,
          reasons,
          selection: [...selected.keys()],
          dependencies: skill.zeuz.dependencies ?? [],
          budgetBytes,
          consumedBytes: 0,
        });
      }
      reasons.push({ code: 'dependency', skillId: dep.id, detail: skill.id });
      queue.push(dep);
    }
  }

  const ordered = [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
  let consumed = 0;
  for (const skill of ordered) {
    consumed += skill.zeuz.contextBudgetBytes ?? skill.totalBytes;
    if (consumed > budgetBytes) {
      reasons.push(rejectReason(skill, 'rejected_budget', `${consumed}/${budgetBytes}`));
      throw activationError({
        code: 'SKILL_CONTEXT_BUDGET_EXCEEDED',
        message: `Activation exceeds context budget (${consumed}/${budgetBytes} bytes).`,
        reasons,
        selection: ordered.map((item) => item.id),
        dependencies: ordered.flatMap((item) => item.zeuz.dependencies ?? []),
        budgetBytes,
        consumedBytes: consumed,
      });
    }
  }
  return { ordered, reasons };
}

export async function loadActivationContext(index: CatalogIndex, task: string, budgetBytes = DEFAULT_ACTIVATION_BUDGET_BYTES, root = installRoot()): Promise<ActivationResult> {
  const { ordered, reasons } = resolveActivation(index, task, budgetBytes);
  const selected = [];
  let consumedBudgetBytes = 0;
  for (const skill of ordered) {
    const { skillMdPath, rootPath } = await validateSkillPaths(root, skill);
    const raw = await readBoundedFile(skillMdPath);
    const instruction = parseSkillMarkdown(raw, skillDirectoryName(rootPath)).body;
    consumedBudgetBytes += Buffer.byteLength(instruction, 'utf8');
    selected.push({
      skillId: skill.id,
      canonicalId: skill.id,
      revision: skill.source.revision,
      trust: skill.zeuz.trust,
      enablement: skill.zeuz.enablement,
      networkPolicy: skill.zeuz.networkPolicy ?? 'offline',
      reasons: reasons.filter((reason) => reason.skillId === skill.id),
      instruction,
      path: skillMdPath,
    });
  }
  return { selected, reasons, contextBudgetBytes: budgetBytes, consumedBudgetBytes };
}

export function formatActivationXml(result: ActivationResult, nameById: Map<string, string>): string {
  const escapeXml = (value: string): string => value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  return result.selected.map((skill) => {
    const name = nameById.get(skill.skillId) ?? skill.skillId.split('/').pop()?.split('@')[0] ?? skill.skillId;
    return `<skill name="${escapeXml(name)}" id="${escapeXml(skill.canonicalId)}" revision="${escapeXml(skill.revision)}" trust="${escapeXml(skill.trust)}" network-policy="${escapeXml(skill.networkPolicy ?? 'offline')}" path="${escapeXml(skill.path)}">\n${escapeXml(skill.instruction)}\n</skill>`;
  }).join('\n\n');
}
