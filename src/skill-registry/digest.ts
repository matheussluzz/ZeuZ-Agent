import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}

export function digestInventory(files: Array<{ path: string; sha256: string; size: number }>): string {
  const canonical = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\t${file.size}\t${file.sha256}`)
    .join('\n');
  return sha256Hex(canonical);
}
