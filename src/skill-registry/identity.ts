import { readFile } from 'node:fs/promises';

import YAML from 'yaml';

import { SkillRegistryError } from './errors.js';
import type { EnablementState, TrustState, ZeuzSkillExtension } from './types.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

export function normalizeSkillId(namespace: string, name: string, version: string): string {
  const id = `${namespace}/${name}@${version}`;
  if (!ID_PATTERN.test(namespace) || !ID_PATTERN.test(name) || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) {
    throw new SkillRegistryError('SKILL_ID_INVALID', `Invalid canonical skill id: ${id}`);
  }
  return id;
}

export function parseZeuzManifest(content: string, defaults: Partial<ZeuzSkillExtension> = {}): ZeuzSkillExtension {
  const parsed = YAML.parse(content) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillRegistryError('ZEUZ_MANIFEST_INVALID', 'zeuz.manifest.yaml must be a mapping.');
  }
  const namespace = typeof parsed.namespace === 'string' ? parsed.namespace : defaults.namespace;
  const version = typeof parsed.version === 'string' ? parsed.version : defaults.version ?? '0.1.0';
  if (!namespace) throw new SkillRegistryError('ZEUZ_MANIFEST_INVALID', 'namespace is required.');
  const trustValue = typeof parsed.trust === 'string' ? parsed.trust : defaults.trust ?? 'quarantined';
  if (!['quarantined', 'invalid', 'validated', 'disabled', 'enabled'].includes(trustValue)) {
    throw new SkillRegistryError('ZEUZ_MANIFEST_INVALID', `Invalid trust state: ${trustValue}`);
  }
  const trust = trustValue as TrustState;
  const enablementValue = typeof parsed.enablement === 'string' ? parsed.enablement : defaults.enablement ?? 'disabled';
  if (!['disabled', 'enabled'].includes(enablementValue)) {
    throw new SkillRegistryError('ZEUZ_MANIFEST_INVALID', `Invalid enablement state: ${enablementValue}`);
  }
  const enablement = enablementValue as EnablementState;
  const triggers = Array.isArray(parsed.triggers) ? parsed.triggers.map(String) : defaults.triggers ?? [];
  const dependencies = Array.isArray(parsed.dependencies) ? parsed.dependencies.map(String) : defaults.dependencies ?? [];
  const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts.map(String) : defaults.conflicts ?? [];
  const capabilityTags = Array.isArray(parsed.capabilityTags) ? parsed.capabilityTags.map(String) : defaults.capabilityTags ?? [];
  const allowedTools = Array.isArray(parsed.allowedTools) ? parsed.allowedTools.map(String) : defaults.allowedTools ?? [];
  const networkPolicyValue = typeof parsed.networkPolicy === 'string' ? parsed.networkPolicy : defaults.networkPolicy ?? 'offline';
  if (!['offline', 'explicit-sync-only', 'declared'].includes(networkPolicyValue)) {
    throw new SkillRegistryError('ZEUZ_MANIFEST_INVALID', `Invalid network policy: ${networkPolicyValue}`);
  }
  const networkPolicy = networkPolicyValue as NonNullable<ZeuzSkillExtension['networkPolicy']>;
  const contextBudgetBytes = typeof parsed.contextBudgetBytes === 'number' ? parsed.contextBudgetBytes : defaults.contextBudgetBytes;
  const extension: ZeuzSkillExtension = {
    namespace,
    version,
    triggers,
    dependencies,
    conflicts,
    allowedTools,
    networkPolicy,
    trust,
    enablement,
    capabilityTags,
  };
  if (contextBudgetBytes !== undefined) extension.contextBudgetBytes = contextBudgetBytes;
  return extension;
}

export async function readZeuzManifest(path: string, defaults?: Partial<ZeuzSkillExtension>): Promise<ZeuzSkillExtension> {
  return parseZeuzManifest(await readFile(path, 'utf8'), defaults);
}

export function rejectConfusablePath(segment: string): void {
  if (!segment || segment === '.' || segment === '..') throw new SkillRegistryError('PATH_CONFUSABLE', `Rejected path segment: ${segment}`);
  if (segment.includes('\\') || segment.includes('\0')) throw new SkillRegistryError('PATH_CONFUSABLE', `Rejected path segment: ${segment}`);
  if (/[\u200B-\u200D\uFEFF]/.test(segment)) throw new SkillRegistryError('PATH_CONFUSABLE', 'Rejected unicode confusable path segment.');
}
