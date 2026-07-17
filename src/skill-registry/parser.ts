import { readFile } from 'node:fs/promises';

import YAML from 'yaml';

import type { PortableSkillMetadata } from './types.js';
import { SkillRegistryError } from './errors.js';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface ParsedSkillDocument {
  frontmatter: Record<string, unknown>;
  body: string;
  portable: PortableSkillMetadata;
}

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new SkillRegistryError('SKILL_FRONTMATTER_INVALID', `${field} must be a string.`);
  return value;
}

function asMetadataMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SkillRegistryError('SKILL_FRONTMATTER_INVALID', 'metadata must be a map of strings.');
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') throw new SkillRegistryError('SKILL_FRONTMATTER_INVALID', `metadata.${key} must be a string.`);
    result[key] = item;
  }
  return result;
}

export function validatePortableName(name: string, directoryName: string): void {
  if (name.length < 1 || name.length > 64) throw new SkillRegistryError('SKILL_NAME_INVALID', 'Skill name length is out of bounds.');
  if (!NAME_PATTERN.test(name)) throw new SkillRegistryError('SKILL_NAME_INVALID', 'Skill name has invalid characters.');
  if (name.includes('--')) throw new SkillRegistryError('SKILL_NAME_INVALID', 'Skill name cannot contain consecutive hyphens.');
  if (name !== directoryName) throw new SkillRegistryError('SKILL_NAME_DIRECTORY_MISMATCH', 'Skill name must match parent directory.');
}

export function parseSkillMarkdown(content: string, directoryName: string): ParsedSkillDocument {
  const match = FRONTMATTER.exec(content);
  if (!match) throw new SkillRegistryError('SKILL_FRONTMATTER_MISSING', 'SKILL.md frontmatter is required.');
  const frontmatter = YAML.parse(match[1] ?? '') as Record<string, unknown> | null;
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new SkillRegistryError('SKILL_FRONTMATTER_INVALID', 'SKILL.md frontmatter must be a mapping.');
  }
  const name = asString(frontmatter.name, 'name');
  const description = asString(frontmatter.description, 'description');
  if (!name) throw new SkillRegistryError('SKILL_NAME_MISSING', 'SKILL.md name is required.');
  if (!description || !description.trim()) throw new SkillRegistryError('SKILL_DESCRIPTION_MISSING', 'SKILL.md description is required.');
  if (description.length > 1024) throw new SkillRegistryError('SKILL_DESCRIPTION_INVALID', 'SKILL.md description exceeds 1024 characters.');
  validatePortableName(name, directoryName);
  const compatibility = asString(frontmatter.compatibility, 'compatibility');
  if (compatibility && (compatibility.length < 1 || compatibility.length > 500)) {
    throw new SkillRegistryError('SKILL_COMPATIBILITY_INVALID', 'compatibility exceeds 500 characters.');
  }
  const portable: PortableSkillMetadata = {
    name,
    description: description.trim(),
  };
  const license = asString(frontmatter.license, 'license');
  if (license) portable.license = license;
  if (compatibility) portable.compatibility = compatibility;
  const metadata = asMetadataMap(frontmatter.metadata);
  if (metadata) portable.metadata = metadata;
  const allowedTools = asString(frontmatter['allowed-tools'], 'allowed-tools');
  if (allowedTools) portable.allowedTools = allowedTools;
  return { frontmatter, body: content.slice(match[0].length), portable };
}

export async function readSkillMetadata(skillMdPath: string, directoryName: string): Promise<PortableSkillMetadata> {
  const content = await readFile(skillMdPath, 'utf8');
  return parseSkillMarkdown(content, directoryName).portable;
}

export async function readSkillBody(skillMdPath: string, directoryName: string): Promise<string> {
  const content = await readFile(skillMdPath, 'utf8');
  return parseSkillMarkdown(content, directoryName).body;
}
