# @ia-flow/ai-providers — cómo se arma el body a Anthropic

Este documento sigue un run desde que una regla dispara un agente hasta el
`POST /v1/messages`, y dice **quién aporta cada campo del body**. Usa como
caso concreto el `implementer` del deploy `claw-agents`
(`agents/ai-development-flow/config/projects/lahaus-ai-flow/agents/20-implementer.yaml`),
pero el camino es el mismo para cualquier agente que corra en `anthropic-api`,
local o detrás de un agent-host remoto.

## El grafo

```mermaid
flowchart TD
  R[Regla 20-build.yaml<br/>brief + agentId: implementer] --> O[AgentOrchestrator.runAgent<br/>packages/agent-engine/src/AgentOrchestrator.ts]
  O --> RC[resolveRunContext<br/>run-context.ts: selectAgent + repoPaths]
  O --> RP[resolveProvider<br/>provider-selection.ts<br/>remote:* → anthropic-api]
  RC --> A[Agent.run<br/>Agent.ts]
  RP --> A

  subgraph A1[Agent.run arma el ProviderInput]
    V[resolveVariables<br/>variable-resolver.ts<br/>agentDef.prompt + task + project + repos] --> P[resolvedPrompt]
    S[resolveSystemPromptBlocks<br/>system-prompt-blocks.ts<br/>project.systemPrompts → defaults → agent.systemPrompts] --> SB[systemPromptBlocks]
    W[prepareWorkspace<br/>el provider decide paths] --> G[buildGitContext<br/>git-context.ts]
    G --> FP[finalPrompt =<br/>gitContext + brief + resolvedPrompt]
    P --> FP
    M[resolveMcpCatalog<br/>mcpCatalogIds → catálogo + interpolateMcpServers<br/>GITHUB_TOKEN ya resuelto] --> PC[providerConfig.mcpServers]
    PO[compilePolicy<br/>@ia-flow/tools<br/>tools[] → policy.toolNames + bashRun] --> POL[policy]
  end

  A --> A1
  FP --> PI[provider.run ProviderInput]
  SB --> PI
  PC --> PI
  POL --> PI

  PI -->|remote:*| RM[RemoteAgentProvider.run<br/>apps/server/src/adapters/remote-provider<br/>Set→array, POST /v1/run]
  RM --> AH[agent-host app.ts<br/>resolveWorkspace: clona, reescribe repoPaths]
  AH --> AP
  PI -->|anthropic-api local| AP

  subgraph AP[AnthropicApiProvider.run  anthropic-api/provider.ts]
    L[loadProviderConfig<br/>DEFAULT_ANTHROPIC_SETTINGS + settings guardados] --> CFG[cfg]
    PA[parseAgentConfig input.providerConfig<br/>schema strict: model, maxTokens, effort...] --> RES[resolvedModel / maxTokens / effort / thinking]
    CFG --> RES
    CFG --> SYS[systemBlocks = input.systemPromptBlocks + cfg.systemPrompt<br/>cache_control en el ÚLTIMO]
    PA --> MCP[toApiMcpServers<br/>drop stdio, headers → authorization_token]
    MCP --> H[buildAnthropicHeaders auth.ts<br/>anthropic-version + anthropic-beta<br/>mcp-client, task-budgets]
    POL2[policy.toolNames → getToolDefinitions<br/>providerKind sync] --> TD[toolDefs]
    TD --> BODY
    MCP --> BODY
    SYS --> BODY
    RES --> BODY
    BODY[fetchApi body<br/>model, max_tokens, system, messages, stream,<br/>cache_control, tools, thinking, mcp_servers, output_config]
  end

  AP --> EL[executeLoop  packages/tools/src/engine.ts<br/>messages = resumeMessages ?? user: finalPrompt<br/>compacta → saveCheckpoint → fetchApi]
  EL --> REQ[requestAnthropicApi<br/>POST /v1/messages, SSE]
```

## Las cuatro etapas

### 1. Dispatch — quién corre y dónde

`AgentOrchestrator.runAgent` (`packages/agent-engine/src/AgentOrchestrator.ts`)
recibe el dispatch que produjo una regla (`rules/20-build.yaml`: `agentId: implementer`
más un `brief`). Hace dos cosas antes de tocar el prompt:

- `resolveRunContext` (`run-context.ts`) vuelve a correr `selectAgent` contra el status
  fresco del issue y arma el layout de repos (`repoPaths`, repo primario, workflow).
- `resolveProvider` (`provider-selection.ts`) recorre el `provider[]` del agente en
  orden. El implementer declara `remote:*` primero y `anthropic-api` después: prueba cada
  agent-host registrado (`canAccept`) y cae al provider local si ninguno admite.

### 2. `Agent.run` — el `ProviderInput`

`packages/agent-engine/src/Agent.ts` arma **todo lo que el modelo va a ver**, ya
resuelto. El provider no reinterpreta nada de esto.

| Pieza | Función | Entrada | Salida |
| --- | --- | --- | --- |
| Prompt del agente | `resolveVariables` (`variable-resolver.ts`) | `agentDef.prompt` con `{{task.*}}`, `{{project.*}}`, `{{repos.*}}`, `variables` | `resolvedPrompt` |
| System prompts | `resolveSystemPromptBlocks` (`system-prompt-blocks.ts`) | `project.systemPrompts[]` → los marcados `default` → `agentDef.systemPrompts[]` (ids del catálogo o `{text}` inline, sin duplicar ids) | `systemPromptBlocks[]` |
| Terreno | `provider.prepareWorkspace` + `buildGitContext` (`git-context.ts`) | repos con coordenadas, branch, `needsWrite` | bloque markdown con branch/worktree/repo |
| User turn | concatenación en `Agent.run` | `gitContext` + `## Por qué estás corriendo` (el `brief` de la regla) + `resolvedPrompt` | `finalPrompt` |
| MCP | `resolveMcpCatalog` + `interpolateMcpServers` | `mcpCatalogIds: [github-mcp]` → entrada del catálogo de `runner.yaml`; `${GITHUB_TOKEN}` se resuelve **acá, en el daemon** | `providerConfig.mcpServers` con el token real |
| Policy | `compilePolicy` (`@ia-flow/tools`) | `tools[]` del yaml, incluido el allow/deny de `bash_run` | `policy.toolNames` (un `Set`) + `policy.bashRun` |

El orden del user turn es deliberado: el git context es terreno, el brief enmarca cómo
leer el prompt, y el prompt es el método. Un run que reanuda una pausa manda
`resumeMessages` en vez del prompt.

### 3. El salto remoto (sólo con `remote:*`)

`RemoteAgentProvider.run` (`apps/server/src/adapters/remote-provider/`) serializa el
`ProviderInput` completo y lo POSTea a `/v1/run` del agent-host con el bearer de la
registración. Dos detalles:

- `policy.toolNames` es un `Set` y `JSON.stringify` lo convierte en `{}`; se pasa a array
  antes de serializar y el provider lo reconstruye del otro lado.
- El agent-host (`apps/agent-host/src/app.ts`, `resolveWorkspace`) **sólo recalcula
  `repoPaths` y `writePaths`** sobre su disco, clonando si nunca vio el repo. Prompt,
  system, policy y `mcpServers` (con el token ya dentro) pasan verbatim al **mismo**
  `AnthropicApiProvider`.

### 4. `AnthropicApiProvider.run` — el body

`packages/ai-providers/src/anthropic-api/provider.ts`. Dos fuentes de config se mezclan
con precedencia **agente > provider**:

- `cfg`: `loadProviderConfig()` (`apps/server/src/application/provider-config.ts`),
  que es `DEFAULT_ANTHROPIC_SETTINGS` pisado por lo guardado en settings (o por
  `runner.yaml` en el runner). Trae `model`, `maxTokens`, `stream`, `thinking`,
  `anthropicBeta`, `anthropicVersion`, `mcpServers` y un `systemPrompt[]` global.
- `pc`: `parseAgentConfig(input.providerConfig)` contra `AnthropicApiAgentConfigSchema`,
  que es **strict**. Un campo desconocido invalida el objeto entero y se pierde todo,
  incluido `mcpServers`.

| Campo del body | Origen (implementer) | Dónde se arma |
| --- | --- | --- |
| `model` | `providerConfig.model: claude-opus-5`, si no `cfg.model` | `resolvedModel` |
| `max_tokens` | `pc.maxTokens` → `cfg.maxTokens` → 32000; `bumpMaxTokens` lo dobla en el retry por tool_use truncado | `fetchApi` |
| `system[]` | `input.systemPromptBlocks` + `cfg.systemPrompt`; `cache_control: ephemeral` **sólo en el último** bloque | `systemBlocks` |
| `messages` | `resumeMessages` si hay checkpoint, si no `[{ role: 'user', content: finalPrompt }]`; después, el historial que `executeLoop` acumula | `executeLoop` |
| `stream` | `cfg.stream`, default `true` | `fetchApi` |
| `cache_control` (request) | fijo, breakpoint automático en `messages` | `fetchApi` |
| `tools[]` | `tool_search_tool_regex` (si MCP diferido) + `getToolDefinitions({ providerKind: 'sync', toolNames: policy.toolNames, selectableExits, outputFields })` + un `mcp_toolset` por server | `toolDefs` + `mcpToolsets` |
| `mcp_servers[]` | `toApiMcpServers(pc.mcpServers ?? cfg.mcpServers)`: descarta `stdio`, convierte `headers.Authorization` a `authorization_token` | `apiMcpServers` |
| `thinking` | `pc.thinkingBudgetTokens` → modo `enabled` acotado a `max_tokens - 1024`; si no, `cfg.thinking` | `fetchApi` |
| `output_config` | `effort` y `taskBudgetTokens` del agente o de `cfg` | `outputConfig` |
| headers | `cfg.anthropicBeta` + `mcp-client-2025-11-20` si hay MCP + `task-budgets-2026-03-13` si hay task budget; auth por `auth.ts` | `buildAnthropicHeaders` |

Con MCP, las tools del server van **diferidas** por default (`defer_loading: true` +
la tool de búsqueda). `eagerMcpTools: true` en `providerConfig` carga el catálogo entero
desde el primer request.

`executeLoop` (`packages/tools/src/engine.ts`) es dueño de `messages`: compacta si hace
falta, llama `saveCheckpoint` con lo que va a mandar y recién después `fetchApi`. Lo
persistido es exactamente el request enviado.

## Tres cosas que muerden

- **`providerConfig` es strict por provider.** El implementer sólo lleva `model` porque
  su primer candidato es `remote:*` y un campo exclusivo de `anthropic-api` (`effort`,
  `maxTokens`, `taskBudgetTokens`) haría fallar el `safeParse` del otro lado. El
  provider caería a sus defaults sin log, y el agente arrancaría **sin las tools del MCP
  de GitHub**.
- **Los secretos cruzan el cable resueltos.** `interpolateMcpServers` corre en el daemon,
  así que el `${GITHUB_TOKEN}` de `runner.yaml` viaja como token real dentro del JSON al
  agent-host. Cada agent-host al que se despacha queda confiado con ese token.
- **`cfg.systemPrompt` va al final, no al principio.** El bloque global del provider se
  apendea después de los del proyecto y del agente, y es el que recibe el breakpoint de
  cache. Mover prompt estable del agente al `systemPrompts[]` es lo que lo hace cacheable.

## Ver el body real

El provider loguea la forma del request en `info` (`event: 'api.request'`: iteración,
cantidad de mensajes, model, max_tokens). El body completo, con el historial entero,
sólo sale en `debug` bajo el mismo evento. Es cuadrático sobre la longitud del run, así
que no lo dejes activo en un daemon de producción.
