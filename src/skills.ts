import { installRoot } from './env.js';
import { createSkillRegistryAdapter } from './skill-registry/adapter.js';
import { PortableSkillRegistry } from './skill-registry/registry.js';
import type { SkillListItem } from './skill-registry/types.js';

export interface SkillInfo {
  name: string;
  path: string;
}

export class SkillRegistry {
  private readonly registry = new PortableSkillRegistry();
  private readonly adapter = createSkillRegistryAdapter(this.registry);
  readonly root = installRoot();

  async list(): Promise<SkillInfo[]> {
    return this.adapter.list();
  }

  async contextFor(task: string): Promise<string | undefined> {
    return this.adapter.contextFor(task);
  }

  async searchCatalog(query = ''): Promise<SkillListItem[]> {
    return await this.registry.search(query, 'non-pantheon');
  }

  async resolveCatalogSkill(query: string): Promise<SkillListItem> {
    const skill = await this.registry.resolve(query, 'non-pantheon');
    return skill;
  }

  async contextForSkill(skillId: string, task = ''): Promise<string> {
    const skill = await this.registry.resolve(skillId, 'non-pantheon');
    return await this.registry.contextForSkill(skill.id, task, { scope: 'non-pantheon' });
  }

  async contextForPantheonSkill(skillId: string, task = '', budgetBytes?: number): Promise<string> {
    const skill = await this.registry.resolve(skillId, 'pantheon');
    return await this.registry.contextForSkill(skill.id, task, { scope: 'pantheon', ...(budgetBytes === undefined ? {} : { budgetBytes }) });
  }
}
