import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import YAML from 'yaml';

const SECRET_NAME = /(?:API_KEY|ACCESS_KEY|TOKEN|PASSWORD|SECRET|PRIVATE_KEY|CREDENTIAL|AUTH(?:ORIZATION)?|COOKIE)/i;

export function installRoot(): string {
  if (process.env.ZEUZ_INSTALL_DIR) return process.env.ZEUZ_INSTALL_DIR;
  const sourceRoot = resolve(import.meta.dirname, '..');
  if (existsSync(resolve(sourceRoot, 'package.json'))) return sourceRoot;
  const buildRoot = resolve(import.meta.dirname, '..', '..');
  if (existsSync(resolve(buildRoot, 'package.json'))) return buildRoot;
  return sourceRoot;
}

export function loadZeuZEnvironment(): void {
  const envFile = resolve(installRoot(), '.env');
  if (assertPrivateConfigurationFile(envFile, '.env')) {
    loadEnvFile(envFile);
  }
  loadLamineConfiguration();
}

interface LamineConfiguration {
  nvidia?: {
    base_url?: string;
    api_keys?: Record<string, string>;
    models?: Record<string, string>;
  };
}

const LAMINE_KEYS: Record<string, string> = {
  glm_5_2: 'NVIDIA_API_KEY_GLM_52',
  deepseek_v4: 'NVIDIA_API_KEY_DEEPSEEK_V4',
  kimi_2_6: 'NVIDIA_API_KEY_KIMI_26',
  minimax_m3: 'NVIDIA_API_KEY_MINIMAX_M3',
  qwen: 'NVIDIA_API_KEY_QWEN',
};

const LAMINE_MODELS: Record<string, string> = {
  glm_5_2: 'NVIDIA_MODEL_GLM_52',
  deepseek_v4: 'NVIDIA_MODEL_DEEPSEEK_V4',
  kimi_2_6: 'NVIDIA_MODEL_KIMI_26',
  minimax_m3: 'NVIDIA_MODEL_MINIMAX_M3',
  qwen: 'NVIDIA_MODEL_QWEN',
};

function loadLamineConfiguration(): void {
  const path = resolve(installRoot(), 'lamine.yaml');
  if (!assertPrivateConfigurationFile(path, 'lamine.yaml')) return;
  const parsed = YAML.parse(readFileSync(path, 'utf8')) as LamineConfiguration | null;
  if (!parsed?.nvidia) return;
  if (typeof parsed.nvidia.base_url === 'string' && parsed.nvidia.base_url.trim()) process.env.NVIDIA_API_BASE_URL = parsed.nvidia.base_url.trim();
  for (const [name, envName] of Object.entries(LAMINE_KEYS)) {
    const value = parsed.nvidia.api_keys?.[name]?.trim();
    if (value && !value.includes('your-key')) process.env[envName] = value;
  }
  for (const [name, envName] of Object.entries(LAMINE_MODELS)) {
    const value = parsed.nvidia.models?.[name]?.trim();
    if (value) process.env[envName] = value;
  }
}

function assertPrivateConfigurationFile(path: string, name: string): boolean {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${name} must be a regular file, not a symlink.`);
  if (metadata.size > 65_536) throw new Error(`${name} is unexpectedly large; refusing to load it.`);
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${name} must be private. Run: chmod 600 ${name}`);
  }
  return true;
}

export function sanitizedChildEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_NAME.test(key)) safe[key] = value;
  }
  return { ...safe, ...extra, TERM: process.env.TERM === 'dumb' ? 'xterm-256color' : (process.env.TERM ?? 'xterm-256color') };
}

export function configuredSecretNames(): string[] {
  return Object.keys(process.env).filter((key) => SECRET_NAME.test(key));
}
