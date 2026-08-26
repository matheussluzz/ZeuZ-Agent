import { installRoot } from './env.js';
import { createSkillRegistryAdapter } from './skill-registry/adapter.js';
import { PortableSkillRegistry } from './skill-registry/registry.js';

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
}
