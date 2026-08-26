import { installRoot } from '../env.js';
import { SkillRegistryError } from './errors.js';
import { buildCatalogIndex, loadCatalogIndex, writeCatalogIndex } from './index.js';
import { effectiveCatalogIndex } from './installer.js';
import { resolveSkillPaths } from './paths.js';
import { formatActivationXml, loadActivationContext, loadExplicitSkillContext } from './resolver.js';
import { applyValidation } from './validator.js';
import type { CatalogSkillRecord, SkillListItem } from './types.js';

export type SkillScope = 'all' | 'pantheon' | 'non-pantheon';

export function isPantheonSkill(skill: CatalogSkillRecord): boolean {
  return skill.zeuz.namespace === 'zeuz/pantheon';
}

function inScope(skill: CatalogSkillRecord, scope: SkillScope): boolean {
  return scope === 'all' || (scope === 'pantheon' ? isPantheonSkill(skill) : !isPantheonSkill(skill));
}

function listItem(root: string, skill: CatalogSkillRecord): SkillListItem {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    namespace: skill.zeuz.namespace,
    path: resolveSkillPaths(root, skill).skillMdPath,
    trust: skill.zeuz.trust,
    enablement: skill.zeuz.enablement,
    source: skill.source.canonicalUrl,
    sourceKind: skill.source.kind,
    revision: skill.source.revision,
  };
}

export class PortableSkillRegistry {
  readonly root: string;

  constructor(root = installRoot()) {
    this.root = root;
  }

  async ensureIndex(): Promise<void> {
    const index = applyValidation(await buildCatalogIndex(this.root));
    await writeCatalogIndex(index, this.root);
  }

  async list(scope: SkillScope = 'all'): Promise<SkillListItem[]> {
    let index = await effectiveCatalogIndex(this.root);
    if (index.skills.length === 0) {
      await this.ensureIndex();
      index = await effectiveCatalogIndex(this.root);
    }
    return index.skills.filter((skill) => inScope(skill, scope)).map((skill) => listItem(this.root, skill)).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async search(query = '', scope: SkillScope = 'non-pantheon'): Promise<SkillListItem[]> {
    const wanted = query.trim().toLocaleLowerCase('pt-BR');
    const candidates = await this.list(scope);
    if (!wanted) return candidates;
    const matches = candidates.filter((skill) => `${skill.id} ${skill.name} ${skill.description} ${skill.namespace} ${skill.source} ${skill.sourceKind} ${skill.trust} ${skill.enablement} ${skill.revision}`.toLocaleLowerCase('pt-BR').includes(wanted));
    return matches.sort((left, right) => {
      const leftExact = left.id.toLocaleLowerCase('pt-BR') === wanted || left.name.toLocaleLowerCase('pt-BR') === wanted ? 0 : 1;
      const rightExact = right.id.toLocaleLowerCase('pt-BR') === wanted || right.name.toLocaleLowerCase('pt-BR') === wanted ? 0 : 1;
      return leftExact - rightExact || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    });
  }

  async resolve(query: string, scope: SkillScope = 'all'): Promise<SkillListItem> {
    const wanted = query.trim().toLocaleLowerCase('pt-BR');
    const matches = (await this.search(query, scope)).filter((skill) => skill.id.toLocaleLowerCase('pt-BR') === wanted || skill.name.toLocaleLowerCase('pt-BR') === wanted);
    if (matches.length === 1 && matches[0]) return matches[0];
    if (matches.length > 1) throw new SkillRegistryError('SKILL_ID_AMBIGUOUS', `Skill name is ambiguous: ${query}`);
    throw new SkillRegistryError('SKILL_NOT_FOUND', `Unknown skill id: ${query}`);
  }

  async status(): Promise<string> {
    const index = await loadCatalogIndex(this.root);
    const lines = [`Catalog skills: ${index.skills.length}`, `Bundles: ${index.bundles.length}`];
    for (const bundle of index.bundles) {
      lines.push(`${bundle.bundleId.padEnd(8)} ${bundle.revision.slice(0, 12)} trust=${bundle.trust} enabled=${bundle.enablement} skills=${bundle.skillCount} excluded=${bundle.excludedCount}`);
    }
    return lines.join('\n');
  }

  async contextFor(task: string): Promise<string | undefined> {
    let index = await effectiveCatalogIndex(this.root);
    if (index.skills.length === 0) {
      await this.ensureIndex();
      index = await effectiveCatalogIndex(this.root);
    }
    const activation = await loadActivationContext(index, task, undefined, this.root);
    if (activation.selected.length === 0) return undefined;
    const names = new Map(index.skills.map((skill) => [skill.id, skill.name] as const));
    return formatActivationXml(activation, names);
  }

  async contextForSkill(
    skillQuery: string,
    task = '',
    options: { scope?: SkillScope; budgetBytes?: number } = {},
  ): Promise<string> {
    let index = await effectiveCatalogIndex(this.root);
    if (index.skills.length === 0) {
      await this.ensureIndex();
      index = await effectiveCatalogIndex(this.root);
    }
    const activation = await loadExplicitSkillContext(index, skillQuery, task, options.budgetBytes, this.root, options.scope ?? 'all');
    if (activation.selected.length === 0) throw new SkillRegistryError('SKILL_ACTIVATION_BLOCKED', `Skill ${skillQuery} produced no active instruction.`);
    const names = new Map(index.skills.map((skill) => [skill.id, skill.name] as const));
    return formatActivationXml(activation, names);
  }
}
