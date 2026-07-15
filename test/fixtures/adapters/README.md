# Sanitized adapter protocol fixtures

Synthetic, inspectable event streams for Wave 01 adapter characterization tests. These files mirror the minimum successful sequences that each adapter parser in `src/adapters/` currently expects. They are **not** captured provider output.

## Safety boundary

Fixtures in this directory contain:

- fictional IDs, token counts, and tool names prefixed with `zeuz-fixture`
- no secrets, API keys, credentials, or auth material
- no real user home paths, workspace paths, or machine identifiers
- no raw provider dumps, network payloads, or quota/account metadata
- no `.env`, `lamine.yaml`, vault, or handoff content

Use them only for deterministic offline replay through injected process boundaries. Real provider smokes remain opt-in and separate from CI.

## File index

| File | Provider | Format | Adapter |
| --- | --- | --- | --- |
| `codex.jsonl` | Codex | JSONL | `src/adapters/codex.ts` |
| `cursor.jsonl` | Cursor | JSONL | `src/adapters/cursor.ts` |
| `claude.jsonl` | Claude Code | JSONL | `src/adapters/claude.ts` |
| `copilot.jsonl` | Copilot | JSONL | `src/adapters/copilot.ts` |
| `nvidia.jsonl` | NVIDIA (Copilot-backed GLM) | JSONL | `src/adapters/nvidia.ts` via `CopilotAdapter` |
| `agy.txt` | Antigravity | plain text | `src/adapters/agy.ts` |

## Event shapes

### `codex.jsonl`

One JSON object per line. Minimum success path:

1. `thread.started` — sets native session id from `thread_id`
2. `item.started` with `item.type = command_execution` — tool started
3. `item.completed` with `item.type = command_execution` — tool completed
4. `item.completed` with `item.type = agent_message` and `item.text` — final assistant text
5. `turn.completed` with `usage` — token usage metadata

### `cursor.jsonl` and `claude.jsonl`

Both adapters share the same stream-json shape:

1. `stream_event` with `event.delta.text` (or `delta.content`) — streaming delta
2. `assistant` with `message.content[]` containing `type: tool_use` — tool started
3. additional `stream_event` delta chunks as needed
4. `result` with `result` final text and optional `usage` — completion

`session_id` (or `sessionId`) may appear on any line and is retained as the native session id.

### `copilot.jsonl`

Copilot CLI JSON stream (`--output-format json --stream on`):

1. `assistant.message_delta` with `data.deltaContent` — streaming delta
2. a tool start event whose `type` contains `tool` and ends with `start` (example: `tools.shell.start`) — tool started
3. `assistant.message` with `data.content` — final assistant text
4. `result` with `usage` — completion metadata

The adapter also supplies a session id through CLI flags; fixtures do not need to echo it.

### `nvidia.jsonl`

Same Copilot wire protocol as `copilot.jsonl`, used when `NvidiaAdapter` routes GLM (and other non-direct harness models) through `CopilotAdapter` with NVIDIA provider settings. Content is visibly synthetic via the `[zeuz-nvidia-glm-fixture]` prefix and `provider: nvidia-glm-fixture` usage marker. This exercises the Copilot-backed GLM path, not the direct JSON tool loop used by MiniMax/Qwen/Kimi.

### `agy.txt`

Antigravity (`agy`) emits plain stdout, not JSONL. The adapter treats stdout chunks as `delta` events and the trimmed stdout as the final text. This file is a single synthetic completion line with no structured events.

## Expected replay outcomes

When replayed through the corresponding adapter parser logic, each fixture should yield:

| Fixture | Final text | Native session id | Usage | Tool/delta signal |
| --- | --- | --- | --- | --- |
| `codex.jsonl` | `agent_message.text` | `thread_id` | `turn.completed.usage` | command execution start/complete |
| `cursor.jsonl` | `result.result` | `session_id` | `result.usage` | `stream_event` delta + `tool_use` |
| `claude.jsonl` | `result.result` | `session_id` | `result.usage` | `stream_event` delta + `tool_use` |
| `copilot.jsonl` | `assistant.message.content` | CLI session (outside fixture) | `result.usage` | `message_delta` + tool start |
| `nvidia.jsonl` | `assistant.message.content` | CLI session (outside fixture) | `result.usage` | GLM-marked deltas + tool start |
| `agy.txt` | full trimmed stdout | not supported | not supported | stdout chunk deltas |

## Validation

Every non-empty JSONL line must parse as JSON. From the repository root:

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = 'test/fixtures/adapters';
for (const file of ['codex.jsonl','cursor.jsonl','claude.jsonl','copilot.jsonl','nvidia.jsonl']) {
  const lines = readFileSync(join(dir, file), 'utf8').split('\\n').filter((l) => l.trim());
  lines.forEach((line, i) => JSON.parse(line));
  console.log(file + ': ' + lines.length + ' lines OK');
}
const agy = readFileSync(join(dir, 'agy.txt'), 'utf8').trim();
if (!agy) throw new Error('agy.txt is empty');
console.log('agy.txt: plain text OK (' + agy.length + ' chars)');
"
```
