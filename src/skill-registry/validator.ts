import type { CatalogIndex, CatalogSkillRecord, TrustState } from './types.js';
import { SkillRegistryError } from './errors.js';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  trust: TrustState;
}

function byId(skills: CatalogSkillRecord[]): Map<string, CatalogSkillRecord> {
  const map = new Map<string, CatalogSkillRecord>();
  for (const skill of skills) {
    if (map.has(skill.id)) throw new SkillRegistryError('SKILL_ID_COLLISION', `Duplicate canonical id: ${skill.id}`);
    map.set(skill.id, skill);
  }
  return map;
}

export function validateCatalogIndex(index: CatalogIndex): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  const names = new Map<string, string>();

  for (const skill of index.skills) {
    if (ids.has(skill.id)) errors.push(`duplicate-id:${skill.id}`);
    ids.add(skill.id);
    const prior = names.get(skill.name);
    if (prior && prior !== skill.id) warnings.push(`alias-collision:${skill.name}`);
    names.set(skill.name, skill.id);
    if (!skill.description.trim()) errors.push(`missing-description:${skill.id}`);
    for (const dep of skill.zeuz.dependencies ?? []) {
      if (dep === skill.name) errors.push(`self-dependency:${skill.id}`);
    }
    for (const pattern of skill.zeuz.triggers ?? []) {
      try {
        // eslint-disable-next-line no-new
        new RegExp(pattern, 'i');
      } catch {
        errors.push(`invalid-trigger:${skill.id}`);
      }
    }
  }

  const map = byId(index.skills);
  for (const skill of index.skills) {
    for (const depName of skill.zeuz.dependencies ?? []) {
      const dep = [...map.values()].find((candidate) => candidate.name === depName);
      if (!dep) errors.push(`missing-dependency:${skill.id}:${depName}`);
    }
    for (const conflictName of skill.zeuz.conflicts ?? []) {
      const conflict = [...map.values()].find((candidate) => candidate.name === conflictName);
      if (conflict) warnings.push(`declared-conflict:${skill.id}:${conflictName}`);
    }
  }

  for (const skill of index.skills) {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack = [skill.id];
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      if (visited.has(currentId)) continue;
      if (visiting.has(currentId)) {
        errors.push(`dependency-cycle:${skill.id}`);
        break;
      }
      visiting.add(currentId);
      const current = map.get(currentId);
      if (!current) continue;
      for (const depName of current.zeuz.dependencies ?? []) {
        const dep = [...map.values()].find((candidate) => candidate.name === depName);
        if (dep) stack.push(dep.id);
      }
      visiting.delete(currentId);
      visited.add(currentId);
    }
  }

  const trust: TrustState = errors.length > 0 ? 'invalid' : 'validated';
  return { ok: errors.length === 0, errors, warnings, trust };
}

export function applyValidation(index: CatalogIndex): CatalogIndex {
  const result = validateCatalogIndex(index);
  return {
    ...index,
    skills: index.skills.map((skill) => ({
      ...skill,
      validation: {
        validatedAt: new Date().toISOString(),
        errors: result.errors.filter((error) => error.includes(skill.id) || error.endsWith(`:${skill.name}`)),
        warnings: result.warnings.filter((warning) => warning.includes(skill.id) || warning.includes(`:${skill.name}`)),
      },
      zeuz: {
        ...skill.zeuz,
        trust: skill.zeuz.trust === 'enabled' ? 'enabled' : result.trust === 'invalid' ? 'invalid' : skill.zeuz.trust,
      },
    })),
  };
}
