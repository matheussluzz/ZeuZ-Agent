export const SKILL_REGISTRY_SCHEMA_VERSION = 1;

export type TrustState = 'quarantined' | 'invalid' | 'validated' | 'disabled' | 'enabled';

export type EnablementState = 'disabled' | 'enabled';

export type SkillSourceKind = 'pantheon' | 'bundle' | 'local';

export interface SkillSourceRef {
  kind: SkillSourceKind;
  namespace: string;
  canonicalUrl: string;
  revision: string;
  resolvedAt?: string;
  bundleId?: string;
}

export interface SkillFileRecord {
  path: string;
  size: number;
  sha256: string;
  upstreamPath?: string;
  priorModification?: string;
  zeuzModification?: string;
  localOverride?: boolean;
}

export interface ZeuzSkillExtension {
  namespace: string;
  version: string;
  triggers?: string[];
  dependencies?: string[];
  conflicts?: string[];
  contextBudgetBytes?: number;
  allowedTools?: string[];
  networkPolicy?: 'offline' | 'explicit-sync-only' | 'declared';
  trust: TrustState;
  enablement: EnablementState;
  capabilityTags?: string[];
}

export interface PortableSkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

export interface CatalogSkillRecord {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  rootPath: string;
  skillMdPath: string;
  source: SkillSourceRef;
  portable: PortableSkillMetadata;
  zeuz: ZeuzSkillExtension;
  inventoryDigest: string;
  fileCount: number;
  totalBytes: number;
  validation?: {
    validatedAt?: string;
    errors: string[];
    warnings: string[];
  };
}

export interface CatalogIndex {
  schemaVersion: number;
  generatedAt: string;
  installRoot: string;
  skills: CatalogSkillRecord[];
  bundles: BundleLockSummary[];
}

export interface BundleLockSummary {
  bundleId: string;
  sourceUrl: string;
  revision: string;
  inventoryDigest: string;
  skillCount: number;
  excludedCount: number;
  trust: TrustState;
  enablement: EnablementState;
}

export interface BundleLockFile {
  schemaVersion: number;
  bundleId: string;
  sourceUrl: string;
  revision: string;
  resolvedAt: string;
  license: {
    spdx?: string;
    files: string[];
    noticeFiles: string[];
    trademarkFiles: string[];
  };
  inventoryDigest: string;
  upstreamSkillTotal: number;
  importedSkillTotal: number;
  excluded: Array<{ path: string; reasonCode: string }>;
  files: SkillFileRecord[];
  skills: Array<{ id: string; rootPath: string; inventoryDigest: string }>;
}

export interface RoutingReason {
  code:
    | 'explicit'
    | 'trigger'
    | 'dependency'
    | 'rejected_conflict'
    | 'rejected_disabled'
    | 'rejected_quarantined'
    | 'rejected_missing_dependency'
    | 'rejected_cycle'
    | 'rejected_budget'
    | 'rejected_invalid';
  skillId: string;
  detail?: string;
}

export interface ActivationSelection {
  skillId: string;
  canonicalId: string;
  revision: string;
  trust: TrustState;
  enablement: EnablementState;
  reasons: RoutingReason[];
  instruction: string;
  path: string;
}

export interface ActivationResult {
  selected: ActivationSelection[];
  reasons: RoutingReason[];
  contextBudgetBytes: number;
  consumedBudgetBytes: number;
}

export interface ActivationError extends Error {
  code: string;
  reasons: RoutingReason[];
  selection: string[];
  dependencies: string[];
  budgetBytes: number;
  consumedBytes: number;
}

export interface SkillListItem {
  id: string;
  name: string;
  path: string;
  trust: TrustState;
  enablement: EnablementState;
  source: string;
}

export const DEFAULT_ACTIVATION_BUDGET_BYTES = 256 * 1024;
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_TREE_FILES = 512;
export const MAX_SKILL_TREE_DEPTH = 12;
export const MAX_INDEX_BYTES = 512 * 1024;
