import { PortableSkillRegistry } from './registry.js';

export interface SkillInfo {
  name: string;
  path: string;
}

type LegacySkillProvider = {
  list(): Promise<SkillInfo[]>;
  contextFor(task: string): Promise<string | undefined>;
};

export function createSkillRegistryAdapter(registry = new PortableSkillRegistry()): LegacySkillProvider {
  return {
    async list(): Promise<SkillInfo[]> {
      const skills = await registry.list();
      return skills
        .filter((skill) => skill.path.includes('/skills/'))
        .map((skill) => ({ name: skill.name, path: skill.path }));
    },
    contextFor(task: string): Promise<string | undefined> {
      return registry.contextFor(task);
    },
  };
}
