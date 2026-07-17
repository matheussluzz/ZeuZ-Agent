import { installRoot } from '../env.js';
import { buildCatalogIndex, loadCatalogIndex, writeCatalogIndex } from './index.js';
import { formatActivationXml, loadActivationContext } from './resolver.js';
import { applyValidation } from './validator.js';
import type { SkillListItem } from './types.js';

export class PortableSkillRegistry {
  readonly root: string;

  constructor(root = installRoot()) {
    this.root = root;
  }

  async ensureIndex(): Promise<void> {
    const index = applyValidation(await buildCatalogIndex(this.root));
    await writeCatalogIndex(index, this.root);
  }

  async list(): Promise<SkillListItem[]> {
    let index = await loadCatalogIndex(this.root);
    if (index.skills.length === 0) {
      await this.ensureIndex();
      index = await loadCatalogIndex(this.root);
    }
    return index.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      path: skill.skillMdPath,
      trust: skill.zeuz.trust,
      enablement: skill.zeuz.enablement,
      source: skill.source.canonicalUrl,
    })).sort((left, right) => left.name.localeCompare(right.name));
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
    let index = await loadCatalogIndex(this.root);
    if (index.skills.length === 0) {
      await this.ensureIndex();
      index = await loadCatalogIndex(this.root);
    }
    const activation = await loadActivationContext(index, task);
    if (activation.selected.length === 0) return undefined;
    const names = new Map(index.skills.map((skill) => [skill.id, skill.name] as const));
    return formatActivationXml(activation, names);
  }
}
