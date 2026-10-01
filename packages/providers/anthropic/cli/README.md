# @ia-flow/provider-anthropic-cli

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
  `iaflow-<agente>-task-<n>`, se mira con `tmux attach`; `surface: true` la abre en iTerm). En
  `tmux`, si el CLI abre con el diálogo de confianza del worktree ("Yes, I trust this folder"),
  el launcher lo acepta solo (`sessions/trustDialog.ts`): `--dangerously-skip-permissions` no lo
  saltea y cada task trae un worktree nuevo.
- **Servidor local** (`RunServer`, `127.0.0.1`, puerto efímero, un token por corrida):
  - `POST /mcp/<token>` — el MCP `ia-flow`: `tools/list` y `tools/call` sobre el `Tool[]` de la
    corrida (sus actions + `submit_*`/`fail_turn`/`yield_turn`/`wait_for_event`). Se ejecutan en
    el runner, con el `ctx` de la corrida.
  - `POST /hooks/<token>/<Evento>` — los hooks de Claude Code (`curl` desde el `--settings`):
    `Pre`/`PostToolUse` abren y cierran un span `execute_tool` por tool nativa (colgado del span
    del agente, sale por OTLP); `PostToolUse` entrega el inbox como `additionalContext`; `Stop`
    no deja terminar sin cerrar el turno (insiste `maxStopNudges` veces) y entrega lo que llegó.
    Se reenvían también `SubagentStop`, `SessionStart` y `UserPromptSubmit`.
- **La traza, a medida que pasa** (nada acumulado al final):
  - **Un log por hook** (`hookTaxonomy.ts`, la taxonomía de v1) dentro de la traza del agente y
    con `ia.execution.id`: `tool.pre` (debug), `tool.call` + `tool.result` (apareados por
    `ia.tool.use_id`), `subagent.start` (un `Task`), `subagent.stop`, `agent.prompt`, `agent.stop`,
    `agent.session_start` — el nombre va también en `ia.hook.event`. Inputs, respuestas y prompts
    recortados a 10 KB; `ia.tool.is_error` sólo con un flag explícito (`is_error`/`isError`/
    `success`), nunca adivinado por `stderr`.
  - **Un span `chat <model>` por request al modelo**, leído de la transcripción que el CLI escribe
    (`transcript_path` de cada hook): `TranscriptTail` lee sólo los bytes nuevos (guarda el offset
    y una última línea a medio escribir), junta las líneas de un mismo `message.id` quedándose
    con el último `usage`, y emite cada mensaje apenas se completa — el último, en el `Stop` o al
    cerrar la corrida. Atributos GenAI (`gen_ai.usage.*_tokens`, incluidos los de cache) colgados
    del agente, y el texto a `ctx.onText`. Una sesión retomada no re-emite su historia. Si la
    transcripción falta o no se lee, la corrida sigue igual.
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
