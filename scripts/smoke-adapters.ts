import process from 'node:process';

import { AdapterRegistry } from '../src/adapters/index.js';
import { requireModel } from '../src/catalog.js';
import { loadZeuZEnvironment } from '../src/env.js';

if (process.env.ZEUZ_REAL_SMOKE !== '1') {
  process.stdout.write('SKIP adapter real smokes: set ZEUZ_REAL_SMOKE=1 and explicit ZEUZ_SMOKE_MODELS.\n');
  process.exit(0);
}

const requested = (process.env.ZEUZ_SMOKE_MODELS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
if (requested.length === 0) {
  throw new Error('ZEUZ_SMOKE_MODELS must list explicit model IDs; real smokes never select routes implicitly.');
}

loadZeuZEnvironment();
const registry = new AdapterRegistry();
const timeoutMs = Number.parseInt(process.env.ZEUZ_SMOKE_TIMEOUT_MS ?? '60000', 10);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
  throw new Error('ZEUZ_SMOKE_TIMEOUT_MS must be between 1000 and 300000.');
}

let failures = 0;
for (const query of requested) {
  const model = requireModel(query);
  const adapter = registry.get(model.provider);
  const health = await adapter.health();
  if (!health.ok) {
    failures += 1;
    process.stdout.write(`FAIL ${model.id} — provider health failed: ${health.detail ?? health.version ?? 'unknown'}\n`);
    continue;
  }

  const started = Date.now();
  try {
    const result = await adapter.run({
      model,
      prompt: 'This is an opt-in ZeuZ adapter smoke. Do not use tools or change files. Reply with exactly: zeuz-smoke-ok',
      cwd: process.cwd(),
      mode: 'plan',
      ephemeral: true,
      signal: AbortSignal.timeout(timeoutMs),
    });
    process.stdout.write(`PASS ${model.id} — ${Date.now() - started}ms, ${result.text.length} response characters\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${model.id} — ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

if (failures > 0) process.exitCode = 1;
