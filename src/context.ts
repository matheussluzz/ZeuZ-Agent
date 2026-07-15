import { userInfo } from 'node:os';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { OnboardingAnswers, WorkspaceBootstrap } from './types.js';

const MAX_FILE_CHARACTERS = 24_000;
const MAX_CONTEXT_CHARACTERS = 72_000;

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'user';
}

export function defaultUserSlug(): string {
  return slugify(process.env.USER ?? userInfo().username);
}

async function safeRead(root: string, relativePath: string): Promise<string | undefined> {
  const candidate = resolve(root, relativePath);
  const relation = relative(root, candidate);
  if (relation.startsWith('..') || isAbsolute(relation)) return undefined;
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    const actual = await realpath(candidate);
    const actualRelation = relative(await realpath(root), actual);
    if (actualRelation.startsWith('..') || isAbsolute(actualRelation)) return undefined;
    const content = await readFile(actual, 'utf8');
    return content.length > MAX_FILE_CHARACTERS ? `${content.slice(0, MAX_FILE_CHARACTERS)}\n… context truncated …` : content;
  } catch {
    return undefined;
  }
}

async function writeNew(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function profileDocument(slug: string, answers: OnboardingAnswers): string {
  return `---
user: ${slug}
onboarding_complete: true
use_case: ${answers.useCase}
proficiency: ${answers.proficiency}
updated: ${new Date().toISOString().slice(0, 10)}
---

# User instructions — ${slug}

## Objective

${answers.objective}

## Working context

${answers.context}

## Teaching preference

${answers.teachingPreference}

## Autonomy preference

${answers.autonomyPreference}

## Durable preferences

- Reply in Brazilian Portuguese unless explicitly asked otherwise.
- Explain unfamiliar tools while working; stay compact when the user already knows the subject.
- Record only durable, user-approved preferences here. Never store credentials, secrets, or sensitive source data.
`;
}

const VAULT_FILES: Record<string, string> = {
  'Home.md': `---
id: home
type: index
status: draft
aliases: []
tags: []
source: ""
last_verified: ""
sensitivity: internal
related: []
---

# Knowledge vault

- [[Glossary/Index|Glossary]]
- [[Schemas/Index|Schemas]]
- [[Rules/Index|Rules]]
- [[Sources/Index|Sources]]
- [[Decisions/Index|Decisions]]

Keep every durable note reachable from this page or one of its category indexes.
`,
  'Glossary/Index.md': '# Glossary\n\nAdd canonical terms as `[[Glossary/term-name]]`.\n',
  'Schemas/Index.md': '# Schemas\n\nAdd verified datasets and contracts as `[[Schemas/schema-name]]`.\n',
  'Rules/Index.md': '# Rules\n\nAdd durable business and engineering rules as `[[Rules/rule-name]]`.\n',
  'Sources/Index.md': '# Sources\n\nAdd source notes as `[[Sources/source-name]]`.\n',
  'Decisions/Index.md': '# Decisions\n\nAdd decision records as `[[Decisions/decision-name]]`.\n',
};

export class WorkspaceContextManager {
  async load(cwd: string, userSlug = defaultUserSlug()): Promise<WorkspaceBootstrap> {
    const slug = slugify(userSlug);
    const candidates = ['AGENTS.md', `users/${slug}.md`, 'vault/Home.md', 'vault/Glossary/Index.md', 'vault/Glossary.md'];
    const sections: string[] = [];
    const files: string[] = [];
    const warnings: string[] = [];
    let profile = '';

    for (const path of candidates) {
      const content = await safeRead(cwd, path);
      if (!content) continue;
      files.push(path);
      sections.push(`## ${path}\n\n${content}`);
      if (path === `users/${slug}.md`) profile = content;
    }

    if (!files.includes('AGENTS.md')) warnings.push('AGENTS.md was not found in the active workspace.');
    if (!files.includes('vault/Home.md')) warnings.push('vault/Home.md was not found; run onboarding to initialize the local vault.');
    return {
      userSlug: slug,
      onboardingRequired: !/\bonboarding_complete:\s*true\b/i.test(profile),
      files,
      context: sections.join('\n\n').slice(0, MAX_CONTEXT_CHARACTERS),
      warnings,
    };
  }

  async initialize(cwd: string, userSlug: string, answers: OnboardingAnswers): Promise<WorkspaceBootstrap> {
    const slug = slugify(userSlug);
    await mkdir(resolve(cwd, 'users'), { recursive: true, mode: 0o700 });
    await mkdir(resolve(cwd, 'vault'), { recursive: true, mode: 0o700 });
    await writeNew(resolve(cwd, 'users', `${slug}.md`), profileDocument(slug, answers));

    for (const [relativePath, content] of Object.entries(VAULT_FILES)) {
      const target = resolve(cwd, 'vault', relativePath);
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
      await writeNew(target, content);
    }
    return await this.load(cwd, slug);
  }
}
