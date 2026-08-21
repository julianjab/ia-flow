# Superficie de la Messages API vs lo que `anthropic-api` expone

El provider `anthropic-api` (`packages/ai-providers/src/anthropic-api/provider.ts`) llama
`POST /v1/messages` directo (sin SDK). No expone 1:1 todos los parámetros que la API acepta —
esta tabla es la referencia para saber qué se puede tocar desde un agente, qué sólo desde el
deploy, y qué la API soporta pero ia-flow todavía no cablea.

Fuente: https://platform.claude.com/docs/en/api/messages/create (parámetros top-level de
`POST /v1/messages`).

## Parámetros de la API y su cable en ia-flow

| Parámetro API | ia-flow lo expone | Dónde se configura |
| --- | --- | --- |
| `model` | Sí | `providerConfig.model` (agente) > `anthropicApi.model` (deploy) |
| `max_tokens` | Sí | `providerConfig.maxTokens` (agente) > `anthropicApi.maxTokens` (deploy) > `32000` hardcodeado |
| `messages` | Gestionado por el engine | El loop de tool-calls (`executeLoop`) arma el array; no es configurable |
| `system` | Sí, sólo a nivel deploy | `anthropicApi.systemPrompt[]` + `systemPromptBlocks` del agente (`references/variables.md`). Siempre bloques `{type:'text', cache_control: ephemeral}`, nunca un string suelto |
| `stream` | Sí | `anthropicApi.stream` (deploy). Default `true` — streaming evita que conexiones largas (thinking extendido, MCP remoto) se corten por idle timeout; no lo pongas en `false` sin una razón concreta |
| `thinking` | Sí, sólo a nivel deploy | `anthropicApi.thinking: { type: enabled\|adaptive, budget_tokens? }`. **No** hay override por agente — todo agente del deploy piensa igual |
| `tools` | Gestionado por el engine | Viene de `tools[]` del `AgentDefinition` vía policy compilada, no de `providerConfig` |
| `tool_choice` | **No** | Nunca se envía → la API usa su default (`auto`). No hay forma de forzar `any`/`none`/una tool específica desde un agente hoy |
| `mcp_servers` | Sí | `providerConfig.mcpServers` (agente, gana) o `mcpCatalogIds` → merge en `providerConfig.mcpServers` (`references/providers-and-mcp.md`). Sólo entradas `http`/`sse`; `stdio` se descarta |
| `output_config.effort` | Sí | `providerConfig.effort` (agente) > `anthropicApi.effort` (deploy). Valores: `low\|medium\|high\|xhigh\|max` |
| `output_config.task_budget` | Sí | `providerConfig.taskBudgetTokens` (agente) > `anthropicApi.taskBudgetTokens` (deploy), mínimo `20000`. Activa el beta header `task-budgets-2026-03-13` automáticamente — no lo agregues a mano en `anthropicBeta` |
| `output_config.format` (structured outputs / JSON schema) | **No** | No cableado. Si un agente necesita salida validada por schema, hoy se resuelve con prompt ("responde sólo JSON") + parseo downstream, no con este parámetro |
| `temperature` / `top_p` / `top_k` | **No** | Nunca se envían. En modelos Claude 4.7+ la API los rechaza con 400 si van seteados, así que esto es intencional y no una omisión a corregir |
| `stop_sequences` | **No** | No cableado. Un agente no puede pedir que el modelo pare en un token custom |
| `metadata` (`user_id`) | **No** | No se envía; no hay atribución por-usuario en las requests |
| `service_tier` | **No** | No cableado; siempre el default de la cuenta/API key |
| `container` | **No** | Sin soporte de containers/skills reutilizables vía este provider |
| `inference_geo` | **No** | No cableado |
| `context_management` | Parcial, vía beta header | El deploy trae `context-management-2025-06-27` en `anthropicBeta` por default, pero el provider no arma el bloque `context_management` del body — depende de lo que la API haga con sólo el beta header activo. No asumas control fino de compactado de contexto desde un agente |
| `anthropic-version` (header) | Sí | `anthropicApi.anthropicVersion` (deploy). No hay override por agente |
| `anthropic-beta` (header) | Sí | `anthropicApi.anthropicBeta[]` (deploy) + los que el provider agrega solo (`task-budgets-*` si hay `taskBudgetTokens`, `mcp-client-2025-04-04` si hay `mcpServers`) |
| `cache_control` en bloques de contenido | Parcial | El provider aplica `cache_control: ephemeral` automáticamente a los bloques de `system` (agente + deploy). No hay forma de marcar otros bloques (mensajes, tool results) como cacheables desde `providerConfig` |
| Vision (`image` content blocks) | Indirecto | Si una tool devuelve un bloque `image`, el loop lo reenvía tal cual — no hay una tool de ia-flow que adjunte imágenes al prompt inicial hoy |

## `responseLanguage` — knob muerto

`anthropicApi.responseLanguage` existe en `AnthropicApiSettingsSchema` (default `'español'` en
`DEFAULT_ANTHROPIC_SETTINGS`) pero **el provider nunca lo lee** al armar el body ni el system
prompt. No asumas que setearlo cambia el idioma de respuesta — hoy el idioma se controla sólo
por el contenido de `systemPrompt` / `systemPromptBlocks`. Si necesitas forzar idioma, hazlo
explícito en el prompt/system, no vía este campo.

## Qué puede overridear un agente vs sólo el deploy

El schema **strict** de `providerConfig` para `anthropic-api`
(`AnthropicApiAgentConfigSchema` en `provider.ts`, privado al provider) sólo acepta:

```yaml
providerConfig:
  model: claude-sonnet-5
  maxTokens: 24000
  effort: high
  taskBudgetTokens: 200000
  mcpServers: { ... }
  fileSimplifierEnabled: true
```

Todo lo demás (`anthropicVersion`, `anthropicBeta`, `systemPrompt`, `thinking`, `stream`,
`responseLanguage`) sólo se configura a nivel deploy (`anthropicApi` en `providers.json` /
`AnthropicApiSettingsSchema`) y aplica **a todos los agentes del deploy por igual**. Poner
cualquiera de esos campos en el `providerConfig` de un agente hace que el schema strict lo
rechace completo (config ignorada, no un error parcial — ver checklist en `SKILL.md`).

## MCP connector — ia-flow está en la versión deprecada

`packages/ai-providers/src/anthropic-api/provider.ts` agrega el beta header
`mcp-client-2025-04-04` cuando hay `mcp_servers` en el body. Ese es el **conector viejo**:
Anthropic lo dejó deprecado en favor de `mcp-client-2025-11-20`
(https://platform.claude.com/docs/en/agents-and-tools/mcp-connector). Efectos concretos de
seguir en la versión vieja:

- **Sin allowlist/denylist de tools remotas.** El conector nuevo mueve la config de tools a un
  `MCPToolset` en el array `tools[]` (`default_config.enabled`, `configs.<tool>.enabled`,
  `defer_loading`). El viejo tenía `tool_configuration.allowed_tools` inline en el server —
  ninguno de los dos está cableado en `toApiMcpServers()`. **Hoy un MCP server conectado vía
  `mcpServers`/`mcpCatalogIds` expone TODAS sus tools sin filtro**, no hay forma de acotar
  desde `providerConfig` qué tools de ese servidor puede llamar el agente.
- **Sin `defer_loading`.** Si un catálogo MCP tiene decenas de tools, todas sus descripciones
  se mandan siempre — no hay tool search / carga diferida.
- El shape de `mcp_servers[]` en sí (`type: 'url'`, `url`, `name`, `authorization_token`) es
  compatible entre ambas versiones — eso es lo que `toApiMcpServers()` ya arma bien. Sólo falta
  el bloque de `tools[]` tipo `mcp_toolset` para aprovechar el filtrado del conector nuevo.
- Sólo `type: 'url'` (Streamable HTTP o SSE) está soportado remotamente — coincide con lo que
  ya dice `references/providers-and-mcp.md` sobre que `stdio` se descarta para `anthropic-api`.

**Si un agente necesita acotar qué tools de un MCP server puede tocar hoy**, la única palanca
real es no exponer ese servidor completo (no listarlo en `mcpCatalogIds`/`mcpServers`) o pedir
al MCP server mismo que no registre esa tool — no hay knob de ia-flow para filtrar tool-por-tool
de un servidor remoto todavía.

## Cuándo esto importa para diseñar un agente

- **Necesitas determinismo / salida corta y literal** → no hay `temperature`/`top_p` que bajar.
  Usa `maxTokens` bajo + prompt que pida una única palabra/JSON, o "prefill"-style instrucción
  explícita en el prompt (la API real soporta prefill de mensajes `assistant`, pero el loop de
  ia-flow arma sus propios mensajes — no hay gancho para inyectar uno).
- **Necesitas parar en un delimitador custom** → no hay `stop_sequences`; delimita en el prompt
  y parsea el resultado, o usa `complete_task`/`fail_task` (las tools internas) para que el
  agente señalice el fin en vez de confiar en un stop token.
- **Necesitas forzar que use (o no use) una tool específica** → no hay `tool_choice`; la única
  palanca es reducir `tools[]` del agente a las que quieres que use, o escribirlo en el prompt.
- **Necesitas presupuesto de tokens por task** (no por respuesta) → sí existe:
  `taskBudgetTokens` + `effort`. Es la superficie de control más rica que expone este provider
  hoy; combínalos antes de pedir un parámetro que no está cableado.
- **Necesitas pensar más/menos** → `effort` (agente) y `thinking` (sólo deploy) son las dos
  palancas; no hay `budget_tokens` de thinking por agente.
