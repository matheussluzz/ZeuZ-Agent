# Model-routing research

Date: 2026-07-14
Environment: Matheus's authenticated local CLIs and configured NVIDIA Integrate endpoints

## Why this exists

ZeuZ-Agent routes work across several paid coding-agent subscriptions and NVIDIA-hosted models. A model picker alone is not orchestration: the primary agent needs an explicit prior for which delegate is likely to help, and every artifact needs an independent reviewer.

This document records the baseline used by `AGENTS.md`. It is not a benchmark and does not claim provider-independent scientific validity.

## Method

We first inspected each local CLI's real model catalog and headless protocol. We then sent the same read-only, sub-220-word self-assessment prompt to every enabled model family or effort tier requested by the user. The prompt required best tasks, weak tasks, ideal role, delegation triggers, and a caveat.

Consulted routes:

- Codex: GPT-5.6 Sol, Terra, and Luna at medium reasoning.
- Cursor: Composer 2.5, Fable 5 Thinking High, and Grok 4.5 High as representatives of all enabled variants in those families.
- Claude Code: current official headless/model-alias documentation was inspected. The installed `2.1.159` CLI initialized correctly, but it is below the documented Fable requirement and a real Haiku request returned `401`; direct routes are implemented but non-operational in this baseline.
- Copilot: Claude Sonnet 5, Sonnet 4.6, Sonnet 4.5, and Haiku 4.5.
- Antigravity: Gemini 3.5 Flash Low, Medium, and High.
- NVIDIA: GLM 5.2, DeepSeek V4 Pro, Kimi K2.6, MiniMax M3, and Qwen 3.5 397B.

The answers were cross-compared with operational evidence: supported structured output, native session resume, sandbox controls, tool access, latency, and actual health checks. Self-assessment was treated as a heuristic prior, never as proof.

## Operational findings

| Provider | Structured headless output | Native resume | Tool-capable in ZeuZ | Boundary strategy |
| --- | --- | --- | --- | --- |
| Codex | JSONL events | Yes | Native | Codex read-only/workspace-write/yolo sandbox |
| Cursor | Stream JSON | Yes | Native | Cursor sandbox + workspace root |
| Claude Code | Stream JSON | Yes | Native when authenticated | Claude permission modes + workspace root; baseline failed authentication and Fable version gate |
| Copilot | JSONL events / ACP | Yes | Native | Path verification; built-in remote MCP disabled outside yolo |
| Antigravity | Plain text | CLI supports conversation IDs, but print output does not expose one reliably | Native | Agy sandbox; central handoff for continuity |
| NVIDIA | OpenAI-compatible API | Copilot sessions for GLM/DeepSeek; provider-neutral handoff for direct routes | Copilot BYOK for GLM/DeepSeek; constrained ZeuZ JSON loop for MiniMax/Qwen/Kimi | Selected key redacted and stripped from child tool environments |

The Copilot BYOK route was verified against NVIDIA's GLM endpoint: the event stream identified `z-ai/glm-5.2`, returned successfully, and consumed zero Copilot premium requests.

MiniMax and Qwen returned real responses during direct endpoint research, but both exceeded the 45-second timeout in the hardened final deep check. They must pass a later deep check before consequential work. Direct requests now have bounded abort signals and a lightweight health path.

Kimi K2.6 returned an NVIDIA `404 Function ... not found for account` during both baseline research and health probing. The key name remains supported in configuration, but routing must treat Kimi as unavailable until a deep health check succeeds.

## Cross-model consensus

The strongest repeated signal was not that one model wins every category. It was a tiered workflow:

1. Use a frontier generalist to own ambiguity, integration, and verification.
2. Use fast agents for bounded repository work, exploration, tests, and mechanical changes.
3. Use a careful model from a different family for adversarial review.
4. Verify current APIs, runtime behavior, and security claims with tools instead of model memory.

Models repeatedly admitted these failure modes:

- confident use of stale or invented APIs;
- missed edge cases in concurrency, distributed state, and security;
- degraded coherence across very large or unfocused contexts;
- overengineering by slower deep-reasoning models;
- plausible-looking but subtly wrong code from speed-optimized models;
- weak pixel-level visual judgment without a render/screenshot loop.

## Routing matrix

| Work type | Primary choice | Useful delegate | Adversarial reviewer |
| --- | --- | --- | --- |
| Ambiguous, repository-scale feature | GPT-5.6 Sol | Fable 5 / Sonnet 4.6 | Sonnet 5 |
| Architecture and tradeoffs | GPT-5.6 Terra or Sonnet 4.6 | DeepSeek V4 / Grok 4.5 | Sol High |
| Routine repo-native edit | Composer 2.5 | Luna / Gemini Flash | Terra High |
| Evidence-led multi-file debugging | Fable 5 Thinking | Sol / Sonnet 5 | Terra High |
| Fast triage and alternatives | Grok 4.5 or Luna | Gemini Flash | Sol High |
| Tests, boilerplate, structured transformations | Gemini Flash / GLM / Qwen | Composer / Haiku | Sol High |
| Scoped backend or SQL | MiniMax M3 | Composer / Luna | Terra High |
| Long-context first-pass analysis | DeepSeek V4 | Sol / Fable | Sonnet 5 |
| Documentation synthesis | Qwen / Haiku | Gemini Flash | Terra High |
| Security-sensitive change | Sol High | Sonnet 5 | second independent Sol/Terra or Sonnet reviewer |

## Limits and refresh policy

- The research measures one local account state on one date.
- Provider catalogs, entitlements, prompts, and runtimes change.
- Effort variants were grouped when they share a model family; they are not assumed performance-equivalent.
- A model's own description of itself is especially vulnerable to branding priors and hallucination.
- Refresh this baseline when model families change, after a major CLI update, or when repeated task outcomes contradict the routing policy.

## Primary operational sources

- Claude Code CLI and model configuration: https://code.claude.com/docs/en/cli-usage and https://code.claude.com/docs/en/model-config
- NVIDIA hosted API quickstart: https://docs.api.nvidia.com/nim/re/docs/api-quickstart
- NVIDIA API key setup: https://docs.nvidia.com/nemo/retriever/latest/extraction/api-keys/
- Model Context Protocol TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk

Provider marketing and model self-descriptions were not treated as performance evidence. These sources support protocol/configuration claims only.
