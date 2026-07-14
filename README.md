# agents — terminal NVIDIA LLM

REPL no terminal para conversar com LLMs open source via NVIDIA Integrate API, com troca de modelo via `/model`.

## Setup

```bash
cd ~/Projects/agents
cp .env.example .env   # se ainda não existir
chmod +x bin/agents
```

As chaves ficam só no `.env` (gitignored).

## Uso

```bash
./bin/agents
# ou, de qualquer lugar:
~/Projects/agents/bin/agents

# só health check:
./bin/agents --health-only
# ou
pnpm health
```

Na abertura, o bootstrap roda health check em paralelo e mostra quais modelos respondem. O padrão é **GLM 5.2**.

## Comandos

| Comando | Ação |
| --- | --- |
| `/model` | Lista modelos (✅/❌ do health check) |
| `/model glm_52` | Troca para GLM 5.2 |
| `/model deepseek` | Troca para DeepSeek (aceita aliases) |
| `/health` | Roda health check de novo |
| `/clear` | Limpa histórico da conversa |
| `/help` | Ajuda |
| `/quit` | Sair |

Aliases aceitos: `glm`, `deepseek`, `kimi`, `minimax`, `qwen`, etc.

## Modelos

| ID | Label |
| --- | --- |
| `glm_52` | GLM 5.2 (padrão) |
| `deepseek_v4` | DeepSeek V4 Pro |
| `kimi_26` | Kimi K2.6 |
| `minimax_m3` | MiniMax M3 |
| `qwen` | Qwen 3.5 397B |

## PATH opcional

```bash
ln -sf ~/Projects/agents/bin/agents ~/bin/agents
```

Depois: `agents` de qualquer pasta.
