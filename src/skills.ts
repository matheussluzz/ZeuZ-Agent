import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { installRoot } from './env.js';

const SKILL_TRIGGERS: Record<string, RegExp> = {
  medusa: /(?:\bmedusa\b|adversarial|review|revis(?:ar|ão|ao))/i,
  hermes: /(?:\bhermes\b|linguagem simples|comercial|executiv|explic(?:ar|ação|acao))/i,
  hefesto: /(?:\bhefesto\b|dashboard|highcharts|gr[aá]fico)/i,
  atena: /(?:\batena\b|aws athena|amazon athena|glue catalog)/i,
  clio: /(?:\bclio\b|obsidian|vault|cofre|gloss[aá]rio|wikilink)/i,
  prometeu: /(?:\bprometeu\b|\bsql\b|\bquery\b|consulta.+(?:custo|scan)|bytes scanned)/i,
  argos: /(?:\bargos\b|machine learning|\bml\b|forecast|chronos|timegpt|patchtst|lightgbm|monte carlo|\bvar\b|vecm|rede neural)/i,
  metis: /(?:\bmetis\b|deep research|pesquisa profunda|checagem de fontes|verificar fontes|source ledger)/i,
};

export interface SkillInfo {
  name: string;
  path: string;
}

export class SkillRegistry {
  readonly root = resolve(installRoot(), 'skills');

  async list(): Promise<SkillInfo[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, path: resolve(this.root, entry.name, 'SKILL.md') })).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return [];
    }
  }

  async contextFor(task: string): Promise<string | undefined> {
    const selected = Object.entries(SKILL_TRIGGERS).filter(([, trigger]) => trigger.test(task)).map(([name]) => name);
    if (selected.includes('metis') && !selected.includes('medusa')) selected.push('medusa');
    if (selected.includes('atena')) {
      if (!selected.includes('prometeu')) selected.push('prometeu');
      if (!selected.includes('clio')) selected.push('clio');
    }
    if (selected.length === 0) return undefined;

    const sections: string[] = [];
    for (const name of selected.slice(0, 3)) {
      const path = resolve(this.root, name, 'SKILL.md');
      try {
        const content = await readFile(path, 'utf8');
        sections.push(`<skill name="${name}" path="${path}">\n${content}\n</skill>`);
      } catch {
        sections.push(`<skill name="${name}" unavailable="true" />`);
      }
    }
    return sections.join('\n\n');
  }
}
