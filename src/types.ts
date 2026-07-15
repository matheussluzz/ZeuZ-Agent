export type ProviderId = 'codex' | 'cursor' | 'claude' | 'copilot' | 'agy' | 'nvidia';

export type PermissionMode = 'plan' | 'agent' | 'yolo';

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'status'; text: string }
  | { type: 'tool'; text: string; status?: 'started' | 'completed' | 'failed' }
  | { type: 'diff'; text: string }
  | { type: 'warning'; text: string }
  | { type: 'error'; text: string };

export interface ModelProfile {
  id: string;
  provider: ProviderId;
  model: string;
  label: string;
  family: string;
  description: string;
  aliases: string[];
  reasoningEffort?: string;
  apiKeyEnv?: string;
  modelEnv?: string;
  defaultApiModel?: string;
}

export interface RunRequest {
  model: ModelProfile;
  prompt: string;
  cwd: string;
  mode: PermissionMode;
  resumeId?: string;
  ephemeral?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface RunResult {
  text: string;
  nativeSessionId?: string;
  usage?: Record<string, unknown>;
  rawEvents?: unknown[];
}

export interface AgentAdapter {
  readonly provider: ProviderId;
  run(request: RunRequest): Promise<RunResult>;
  health(): Promise<HealthResult>;
}

export interface HealthResult {
  provider: ProviderId;
  ok: boolean;
  version?: string;
  detail?: string;
  latencyMs?: number;
}

export type SessionMessageRole = 'user' | 'assistant' | 'system' | 'reviewer';

export interface SessionMessage {
  id: string;
  role: SessionMessageRole;
  content: string;
  createdAt: string;
  modelId?: string;
}

export interface ZeuzSession {
  id: string;
  title: string;
  cwd: string;
  activeModelId: string;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  parentId?: string;
  summary?: string;
  summaryUpdatedAt?: string;
  messages: SessionMessage[];
  providerSessions: Record<string, string>;
  lastUsedModelId?: string;
  userSlug?: string;
}

export type ZeuzUseCase = 'development' | 'data' | 'product';

export interface OnboardingAnswers {
  useCase: ZeuzUseCase;
  objective: string;
  context: string;
  proficiency: 'novice' | 'intermediate' | 'advanced';
  teachingPreference: string;
  autonomyPreference: string;
}

export interface WorkspaceBootstrap {
  userSlug: string;
  onboardingRequired: boolean;
  files: string[];
  context: string;
  warnings: string[];
}

export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  file?: string;
  line?: number;
}

export interface ReviewResult {
  verdict: 'PASS' | 'CHANGES_REQUIRED' | 'REVIEW_BLOCKED';
  summary: string;
  findings: ReviewFinding[];
  raw: string;
  reviewerModelId: string;
}

export interface TurnOutcome {
  response: string;
  modelId: string;
  changedWorkspace: boolean;
  review?: ReviewResult;
}

export interface TaskRecord {
  id: string;
  parentSessionId?: string;
  modelId: string;
  prompt: string;
  cwd: string;
  mode: PermissionMode;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  resultPreview?: string;
  error?: string;
}
