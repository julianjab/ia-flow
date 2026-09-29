# @ia-flow/provider-claude-cli

`Provider` de `@ia-flow/agent-engine` sobre el CLI `claude` (Claude Code). El agente corre como
una sesión del CLI en el worktree de la task, con **todo el CLI habilitado** (sus tools nativas,
`Task`, los `.claude/agents` del repo; `--dangerously-skip-permissions`) y, por MCP, las tools
que el agente tiene configuradas.

```ts
providerRegistry.register(
  new ClaudeCliProvider({ id: 'claude-tmux', mode: 'tmux', cwd: (ctx) => session.dirFor(ctx) }),
)
```

## Cómo corre una corrida

- **Modos:** `print` (`claude -p`, headless) o `tmux` (sesión interactiva
  `iaflow-<agente>-task-<n>`, se mira con `tmux attach`; `surface: true` la abre en iTerm).
- **Servidor local** (`RunServer`, `127.0.0.1`, puerto efímero, un token por corrida):
  - `POST /mcp/<token>` — el MCP `ia-flow`: `tools/list` y `tools/call` sobre el `Tool[]` de la
    corrida (sus actions + `submit_*`/`fail_turn`/`yield_turn`/`wait_for_event`). Se ejecutan en
    el runner, con el `ctx` de la corrida.
  - `POST /hooks/<token>/<Evento>` — los hooks de Claude Code (`curl` desde el `--settings`):
    `Pre`/`PostToolUse` abren y cierran un span `execute_tool` por tool nativa (colgado del span
    del agente, sale por OTLP); `PostToolUse` entrega el inbox como `additionalContext`; `Stop`
    no deja terminar sin cerrar el turno (insiste `maxStopNudges` veces) y entrega lo que llegó.
- **Archivos de la sesión** (carpeta 0700, archivos 0600, se borran al terminar):
  `--append-system-prompt-file` (los `systemPrompts` del agente + la nota de sesión
  desatendida), `--settings` (`env` con `CLAUDE_CODE_OAUTH_TOKEN` + hooks), `--mcp-config`
  (`ia-flow` + los MCP externos del agente, con su token como header).
- **Fin del turno:** cuando el modelo llama una tool terminal por MCP, el provider corta la
  sesión y el engine lee la salida elegida. Si la sesión termina sin cerrar el turno, o supera
  `timeoutMinutes`, el resultado es `error`.
- **Conversación:** la sesión del CLI. Arranca con `--session-id <uuid>` (guardado apenas
  empieza: sobrevive a un reinicio del runner) y se retoma con `--resume <id>` — tras
  `wait_for_event` o un reinicio —, con lo que pasó como prompt.
- **Credencial:** `ANTHROPIC_API_KEY` se borra del ambiente; gana `CLAUDE_CODE_OAUTH_TOKEN`.

## Config

Por provider (`runner.yaml`, `providers.<id>` con `type: claude-cli`) y por agente
(`providerConfig`, gana clave por clave): `mode`, `model`, `args`, `env`, `surface`,
`timeoutMinutes`, `maxStopNudges`. Estricta: una clave de otro provider es un error al montar.
