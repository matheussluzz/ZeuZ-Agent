import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { redactSecrets } from './redact.js';
import type { OnboardingAnswers, WorkspaceBootstrap } from './types.js';

const MAX_FILE_CHARACTERS = 24_000;
export const MAX_HANDOFF_CHARACTERS = 12_000;
const MAX_CONTEXT_CHARACTERS = 72_000;
const PROGRESS_HEADER_PATTERN = /^## \d{17} - \d{5} - [0-9a-f]{7,40}$/gm;

const HANDOFF_TEMPLATE = `# ZeuZ handoff

> Private minimum resume capsule. Keep this file Git-ignored, free of secrets, and short.

<!-- zeuz:latest-turn:start -->
## Latest ZeuZ turn

- Updated: not recorded
- Status: not_started
- Model: none
- Latest demand: No substantive task has been recorded yet.
- Public progress: PROGRESS.md
- Next action: Start the next task from PROGRESS.md.
<!-- zeuz:latest-turn:end -->
`;

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'user';
}

export function defaultUserSlug(): string {
  return slugify(process.env.USER ?? userInfo().username);
}

interface SafeReadResult {
  content: string;
  truncated: boolean;
}

export interface HandoffUpdate {
  latestDemand: string;
  modelId: string;
  status: 'in_progress' | 'completed' | 'blocked';
  changedWorkspace?: boolean;
  reviewVerdict?: 'PASS' | 'CHANGES_REQUIRED' | 'REVIEW_BLOCKED';
}

async function safeRead(root: string, relativePath: string, maxCharacters = MAX_FILE_CHARACTERS, requirePrivate = false): Promise<SafeReadResult | undefined> {
  const candidate = resolve(root, relativePath);
  const relation = relative(root, candidate);
  if (relation.startsWith('..') || isAbsolute(relation)) return undefined;
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    if (requirePrivate && process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) return undefined;
    const actual = await realpath(candidate);
    const actualRelation = relative(await realpath(root), actual);
    if (actualRelation.startsWith('..') || isAbsolute(actualRelation)) return undefined;
    const content = await readFile(actual, 'utf8');
    const truncated = content.length > maxCharacters;
    return {
      content: truncated ? `${content.slice(0, maxCharacters)}\n… context truncated …` : content,
      truncated,
    };
  } catch {
    return undefined;
  }
}

async function handoffIsIgnored(root: string): Promise<boolean> {
  const ignore = await safeRead(root, '.gitignore');
  return Boolean(ignore && /^\/?handoff\.md\s*$/m.test(ignore.content));
}

async function latestProgressUtid(root: string): Promise<string> {
  const candidate = resolve(root, 'PROGRESS.md');
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return 'not recorded';
    const actual = await realpath(candidate);
    const actualRelation = relative(await realpath(root), actual);
    if (actualRelation.startsWith('..') || isAbsolute(actualRelation)) return 'not recorded';

    const handle = await open(actual, 'r');
    try {
      const chunkSize = 16 * 1024;
      const boundary = 128;
      let position = metadata.size;
      let suffix = '';
      while (position > 0) {
        const length = Math.min(chunkSize, position);
        position -= length;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, position);
        const chunk = buffer.toString('utf8');
        const matches = `${chunk}${suffix}`.match(PROGRESS_HEADER_PATTERN);
        if (matches?.length) return matches.at(-1)?.slice(3) ?? 'not recorded';
        suffix = `${chunk}${suffix}`.slice(0, boundary);
      }
    } finally {
      await handle.close();
    }
  } catch {
    return 'not recorded';
  }
  return 'not recorded';
}

async function ensureIgnoredHandoff(root: string, warnings: string[]): Promise<void> {
  if (!await handoffIsIgnored(root)) {
    warnings.push('handoff.md was not created because the workspace .gitignore does not exclude it.');
    return;
  }
  try {
    const created = await writeNew(resolve(root, 'handoff.md'), HANDOFF_TEMPLATE);
    if (created) warnings.push('Created private handoff.md starter; replace it after the first substantive writable task.');
  } catch (error) {
    warnings.push(`handoff.md could not be initialized: ${error instanceof Error ? error.message : String(error)}`);
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
  async load(cwd: string, userSlug = defaultUserSlug(), options: { initializeHandoff?: boolean } = {}): Promise<WorkspaceBootstrap> {
    const slug = slugify(userSlug);
    const candidates = ['AGENTS.md', `users/${slug}.md`, 'handoff.md', 'vault/Home.md', 'vault/Glossary/Index.md', 'vault/Glossary.md'];
    const sections: string[] = [];
    const files: string[] = [];
    const warnings: string[] = [];
    let profile = '';

    if (options.initializeHandoff) await ensureIgnoredHandoff(cwd, warnings);

    for (const path of candidates) {
      const result = await safeRead(cwd, path, path === 'handoff.md' ? MAX_HANDOFF_CHARACTERS : MAX_FILE_CHARACTERS, path === 'handoff.md');
      if (!result) continue;
      files.push(path);
      sections.push(`## ${path}\n\n${result.content}`);
      if (result.truncated) warnings.push(`${path} exceeded its ${path === 'handoff.md' ? '12,000' : '24,000'}-character bootstrap ceiling and was truncated.`);
      if (path === `users/${slug}.md`) profile = result.content;
    }

    if (!files.includes('AGENTS.md')) warnings.push('AGENTS.md was not found in the active workspace.');
    if (!files.includes('handoff.md')) warnings.push('handoff.md was not found or is not a private regular file. Add it to .gitignore and run chmod 600 handoff.md.');
    if (!files.includes('vault/Home.md')) warnings.push('vault/Home.md was not found; run onboarding to initialize the local vault.');
    return {
      userSlug: slug,
      onboardingRequired: !/\bonboarding_complete:\s*true\b/i.test(profile),
      files,
      context: sections.join('\n\n').slice(0, MAX_CONTEXT_CHARACTERS),
      warnings,
    };
  }

  async updateHandoff(cwd: string, update: HandoffUpdate): Promise<string | undefined> {
    if (!await handoffIsIgnored(cwd)) return 'handoff.md was not updated because .gitignore does not exclude it.';
    const current = await safeRead(cwd, 'handoff.md', MAX_HANDOFF_CHARACTERS, true);
    if (!current) return 'handoff.md was not updated because it is missing, symlinked, or not private. Run chmod 600 handoff.md.';

    const compact = (value: string, limit: number): string => redactSecrets(value).replace(/\s+/g, ' ').trim().slice(0, limit);
    const progressUtid = await latestProgressUtid(cwd);
    const managed = `<!-- zeuz:latest-turn:start -->
## Latest ZeuZ turn

- Updated: ${new Date().toISOString()}
- Status: ${update.status}
- Model: ${compact(update.modelId, 160)}
- Latest demand: ${compact(update.latestDemand, 1_500)}
- Latest progress: ${progressUtid}
${update.changedWorkspace === undefined ? '' : `- Workspace changed: ${update.changedWorkspace ? 'yes' : 'no'}\n`}${update.reviewVerdict ? `- Adversarial review: ${update.reviewVerdict}\n` : ''}<!-- zeuz:latest-turn:end -->`;
    const fixed = `# ZeuZ handoff\n\n${managed}\n\n- Public progress: PROGRESS.md\n`;
    const content = redactSecrets(fixed);
    const target = resolve(cwd, 'handoff.md');
    const temporary = resolve(cwd, `.handoff.${process.pid}.${randomUUID()}.tmp`);

    try {
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return current.truncated ? 'handoff.md exceeded the bootstrap ceiling; it was replaced by the minimum resume capsule.' : undefined;
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
    return await this.load(cwd, slug, { initializeHandoff: true });
  }
}
