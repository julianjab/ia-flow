# Providers y MCP

## Providers — `runner.yaml` → `providers:`

Cada clave es un id de provider; su valor, los defaults de los agentes que lo usan (con la forma
del `providerConfig` de ese provider) más `maxConcurrent` (del provider). Registro:
`apps/runner-v2/src/providers/providers.ts`.

| Id | Qué es | Schema de su config (strict: una clave ajena rompe al montar) |
| --- | --- | --- |
| `anthropic-api` | Messages API desde el runner, con las `actions` del agente como tools | `RUN_CONFIG_CHECKS` en `packages/providers/anthropic/api/src/AnthropicProvider.ts` (`model`, `maxTokens`, `maxToolRounds`, `thinking`, `effort`, `taskBudgetTokens`, …) |
| cualquier clave con `type: claude-cli` (`claude-cli`, `claude-tmux`) | el CLI `claude` en el worktree de la task; `mode: print` o `tmux` (se mira con `tmux attach`) | `ClaudeCliConfig` en `packages/providers/anthropic/cli/src/config.ts` (`model`, `args`, `env`, `timeoutMinutes`, `maxStopNudges`, …) |
| `remote:<name>` / `remote:*` | un host suscrito (`--host`) que presta su CLI; `*` = el primero que lo acepte | el del CLI del host; ver `apps/runner-v2/README.md` § "Providers en otra máquina" y `packages/providers/remote/` |

No mezcles claves: `maxTokens` en un `claude-cli`, o `args` en `anthropic-api`, no cargan.

## En el agente

```yaml
provider: anthropic-api            # atajo de UN candidato…
providerConfig: { model: claude-opus-5, effort: high }

providers:                         # …o varios, en orden: el primero elegible con lugar
  - id: remote:*
    config: { model: opus }
  - id: claude-tmux
    config: { model: opus }
    # when / whenText opcionales, contra el evento
  - id: anthropic-api
    config: { model: claude-opus-5 }
```

- Si todos están llenos, espera un lugar; no falla. Una conversación retomada (pausa, reinicio)
  sigue en el provider donde empezó.
- **Cierre del turno:** con `anthropic-api` el modelo ve `submit_*`/`fail_turn` como tools. Con un
  CLI llegan por el MCP del runner; si intenta terminar sin llamarlas, se le insiste
  (`maxStopNudges`). Escribí el prompt nombrando las tools, sin afirmar qué provider corre.
- Un CLI trae sus tools nativas (Read/Edit/Bash) además de las `actions`: `actions` no lo acota.

## MCP — `runner.yaml` → `mcp:`

Catálogo de servidores por id (`McpEntrySchema` en `apps/runner-v2/src/config/RunnerConfig.ts`):
`{ id, config: { type: http|sse|stdio, url, authorizationToken, hosted? } }`. El agente los
nombra en `mcpServers: [github-mcp, memory-mcp]`; un id que no está en el catálogo (o no respondió
al arrancar) se omite con un aviso y el agente corre sin él.

- Tokens sólo nombrados: `${FIGMA_MCP_TOKEN}`; `${GITHUB_TOKEN}` resuelve al token de la GitHub
  App.
- Con `anthropic-api` los MCP los llama Anthropic: tienen que ser públicos (`http`/`sse`; `stdio`
  no cruza la red).
- Los que no son de un tercero los levanta el propio runner con `mcpHost:` y los publica en
  `/mcp/<id>`; en `mcp:` llevan `hosted: <id>`. Ver `apps/runner-v2/README.md` § "MCP propios" y
  `apps/runner-v2/src/mcp/`.
- `github-mcp-readonly` existe para agentes que sólo leen: preferilo a `github-mcp` si el agente
  no escribe en GitHub.
