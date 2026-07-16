import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { redactSecrets } from './redact.js';
import { isSensitiveWorkspacePath } from './security-policy.js';
import { assertPrivateStateFile, ensurePrivateStateDirectory, ensureStateContainerDirectory, readPrivateStateFile, writePrivateStateFileCreate } from './state-policy.js';
import { DEFAULT_RESULT_MAX_BYTES, RESULT_SCHEMA_VERSION, assertPortableRelativePath, assertTaskResultReference, type TaskArtifact, type TaskResultReference } from './task-schema.js';

const MAX_ARTIFACT_HASH_BYTES = 32 * 1024 * 1024;

export class TaskResultError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TaskResultError';
    this.code = code;
  }
}

export interface TaskResultStoreOptions {
  root: string;
  now(): string;
  maxBytes?: number;
}

export class TaskResultStore {
  private root: string;
  private resultsRoot: string;
  private readonly maxBytes: number;
  private readonly now: () => string;

  constructor(options: TaskResultStoreOptions) {
    this.root = resolve(options.root);
    this.resultsRoot = join(this.root, 'results');
    this.maxBytes = options.maxBytes ?? DEFAULT_RESULT_MAX_BYTES;
    this.now = options.now;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0 || this.maxBytes > DEFAULT_RESULT_MAX_BYTES) throw new TaskResultError('INVALID_RESULT_BUDGET', 'Result byte budget is invalid.');
  }

  async initialize(): Promise<void> {
    this.root = await ensureStateContainerDirectory(this.root);
    this.resultsRoot = await ensurePrivateStateDirectory(join(this.root, 'results'), this.root);
  }

  async persist(taskId: string, attempt: number, text: string): Promise<TaskResultReference> {
    await this.initialize();
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9._-]/g, '-');
    if (safeTaskId !== taskId || !Number.isSafeInteger(attempt) || attempt < 1) throw new TaskResultError('INVALID_RESULT_ID', 'Result identity is invalid.');
    const redacted = redactSecrets(text);
    const content = Buffer.from(redacted, 'utf8');
    if (content.byteLength > this.maxBytes) throw new TaskResultError('RESULT_TOO_LARGE', 'Complete result exceeds its byte budget.');
    const taskRoot = await ensurePrivateStateDirectory(join(this.resultsRoot, safeTaskId), this.resultsRoot);
    const filename = `${attempt}.txt`;
    const path = join(taskRoot, filename);
    const reference = (): TaskResultReference => ({
      schemaVersion: RESULT_SCHEMA_VERSION,
      path: `results/${safeTaskId}/${filename}`,
      sha256: createHash('sha256').update(content).digest('hex'),
      byteCount: content.byteLength,
      maxBytes: this.maxBytes,
      truncated: false,
      unsafeCompletion: false,
      createdAt: this.now(),
    });
    try {
      await writePrivateStateFileCreate(path, redacted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = await readPrivateStateFile(path, taskRoot, this.maxBytes);
        if (existing === redacted) return reference();
        throw new TaskResultError('RESULT_ALREADY_EXISTS', 'Task result already exists with different content.');
      }
      throw error;
    }
    return reference();
  }

  async retrieve(reference: TaskResultReference): Promise<string> {
    await this.initialize();
    assertTaskResultReference(reference);
    assertPortableRelativePath(reference.path, 'result.path');
    const path = resolve(this.root, reference.path);
    const relation = relative(this.resultsRoot, path);
    if (relation.startsWith('..') || isAbsolute(relation)) throw new TaskResultError('UNSAFE_RESULT_PATH', 'Result reference escapes the result root.');
    const parent = resolve(path, '..');
    const parentReal = await realpath(parent);
    if (relative(this.resultsRoot, parentReal).startsWith('..')) throw new TaskResultError('UNSAFE_RESULT_PATH', 'Result parent escapes the result root.');
    await assertPrivateStateFile(path, parentReal);
    const text = await readPrivateStateFile(path, parentReal, reference.maxBytes);
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.byteLength !== reference.byteCount || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
      throw new TaskResultError('RESULT_INTEGRITY_FAILURE', 'Task result size or hash does not match its reference.');
    }
    return text;
  }

  async verifyForTask(reference: TaskResultReference, taskId: string, attempt: number): Promise<void> {
    if (reference.path !== `results/${taskId}/${attempt}.txt`) throw new TaskResultError('RESULT_OWNERSHIP_MISMATCH', 'Result reference does not belong to this task attempt.');
    await this.retrieve(reference);
  }

  async verifyArtifacts(workspace: string, artifacts: TaskArtifact[]): Promise<void> {
    for (const artifact of artifacts) {
      const verified = await validateArtifact(workspace, artifact);
      if (JSON.stringify(verified) !== JSON.stringify(artifact)) throw new TaskResultError('ARTIFACT_EVIDENCE_MISMATCH', 'Artifact metadata does not match current workspace evidence.');
    }
  }
}

const PRIVATE_PATH = /^(?:handoff\.md|users(?:\/|$)|vault(?:\/|$)|\.agents(?:\/|$))/i;

export async function validateArtifact(workspace: string, artifact: TaskArtifact): Promise<TaskArtifact> {
  assertPortableRelativePath(artifact.path, 'artifact.path');
  const portable = artifact.path.replaceAll('\\', '/');
  if (PRIVATE_PATH.test(portable) || isSensitiveWorkspacePath(portable)) throw new TaskResultError('PRIVATE_ARTIFACT_PATH', 'Artifact path is private or credential-bearing.');
  const workspaceReal = await realpath(workspace);
  const absolute = resolve(workspaceReal, portable);
  const relation = relative(workspaceReal, absolute);
  if (relation.startsWith('..') || isAbsolute(relation)) throw new TaskResultError('UNSAFE_ARTIFACT_PATH', 'Artifact escapes the workspace.');
  if (artifact.kind === 'removed') {
    const parent = await realpath(dirname(absolute)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new TaskResultError('ARTIFACT_EVIDENCE_UNAVAILABLE', 'Removed artifact parent cannot be verified.');
      throw error;
    });
    if (relative(workspaceReal, parent).startsWith('..')) throw new TaskResultError('UNSAFE_ARTIFACT_SYMLINK', 'Removed artifact parent escapes the workspace.');
    try { await lstat(absolute); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: artifact.path, kind: artifact.kind, status: 'missing' };
      throw error;
    }
    throw new TaskResultError('ARTIFACT_EVIDENCE_MISMATCH', 'Removed artifact still exists.');
  }
  await lstat(absolute);
  const filePath = await realpath(absolute);
  if (relative(workspaceReal, filePath).startsWith('..')) throw new TaskResultError('UNSAFE_ARTIFACT_SYMLINK', 'Artifact path escapes the workspace.');
  const fileMetadata = await stat(filePath);
  if (!fileMetadata.isFile()) throw new TaskResultError('UNSUPPORTED_ARTIFACT', 'Artifact is not a file reference.');
  if (fileMetadata.size > MAX_ARTIFACT_HASH_BYTES) throw new TaskResultError('ARTIFACT_TOO_LARGE', 'Artifact exceeds its digest budget.');
  const content = await readFile(filePath);
  return { path: artifact.path, kind: artifact.kind, status: 'captured', sha256: createHash('sha256').update(content).digest('hex'), byteCount: content.byteLength };
}
