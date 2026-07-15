export interface ServerConfig {
  region: string;
  allowedAccount: string;
  workgroup: string;
  catalog: string;
  databases: Set<string>;
  maxRows: number;
  timeoutMs: number;
  outputLocation?: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function loadConfig(): ServerConfig {
  const allowedAccount = required('ZEUZ_AWS_ALLOWED_ACCOUNT');
  if (!/^\d{12}$/.test(allowedAccount)) throw new Error('ZEUZ_AWS_ALLOWED_ACCOUNT must be a 12-digit AWS account ID.');
  const databases = new Set(required('ZEUZ_ATHENA_DATABASE_ALLOWLIST').split(',').map((value) => value.trim()).filter(Boolean));
  if (databases.size === 0) throw new Error('ZEUZ_ATHENA_DATABASE_ALLOWLIST must not be empty.');
  const maxRows = boundedInteger('ZEUZ_ATHENA_MAX_ROWS', 500, 1, 1_000);
  const timeoutMs = boundedInteger('ZEUZ_ATHENA_TIMEOUT_MS', 60_000, 5_000, 300_000);
  const outputLocation = process.env.ZEUZ_ATHENA_OUTPUT_LOCATION?.trim();
  if (outputLocation && !/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](?:\/[^?#]*)?$/i.test(outputLocation)) {
    throw new Error('ZEUZ_ATHENA_OUTPUT_LOCATION must be a valid s3:// bucket prefix without query or fragment components.');
  }
  return {
    region: required('AWS_REGION'),
    allowedAccount,
    workgroup: required('ZEUZ_ATHENA_WORKGROUP'),
    catalog: process.env.ZEUZ_ATHENA_CATALOG?.trim() || 'AwsDataCatalog',
    databases,
    maxRows,
    timeoutMs,
    ...(outputLocation ? { outputLocation } : {}),
  };
}
