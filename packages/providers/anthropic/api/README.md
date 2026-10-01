# @ia-flow/provider-anthropic-api

`Provider` de Anthropic para [`@ia-flow/agent-engine`](../agent-engine/core) — habla la Messages
API real: streaming, retries con backoff, extended thinking, task budgets, MCP remoto y
checkpointing. Portado de `ia-flow/packages/ai-providers/src/anthropic-api`, adaptado al
contrato `Provider` (`{ id, run(ctx) }`) del harness en vez del `IAgentProvider` completo de
ia-flow (que necesita `ToolExecutionPort`, `WorkspaceProvisionerPort` y un compilador de policy
que `agent-engine` no modela).

## Instalar (dentro del monorepo)

```bash
bun run --filter @ia-flow/provider-anthropic-api test
```

`"@ia-flow/provider-anthropic-api": "workspace:*"` en el `package.json` de quien lo use. Es
source-only (los `exports` apuntan a `src/*.ts`, sin build ni `dist/`); su única dependencia
runtime es `@ia-flow/agent-engine`.

## Uso mínimo

```ts
import { Agent, Pipeline, providerRegistry } from '@ia-flow/agent-engine';
import { AnthropicProvider } from '@ia-flow/provider-anthropic-api';

providerRegistry.register(new AnthropicProvider({ id: 'anthropic-api', model: 'claude-sonnet-5' }));

const pipeline = new Pipeline({
  id: 'triage',
  on: ['github.issue.opened'],
  do: [new Agent({ id: 'triage', provider: 'anthropic-api', prompt: '...' })],
});
```

Auth por `apiKey`/`oauthToken` en las opciones, o `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`
en el entorno (el OAuth token gana si están los dos).

## Las dos clases

```
AnthropicClient    auth + headers + retry con backoff + reensamblado de streaming SSE, con
                    streaming INCREMENTAL opcional (`onDelta`). No sabe nada de tools ni de
                    loops — es lo que hablaría CUALQUIER caller (un chat, un clasificador
                    liviano, un script). Se puede usar sola.

AnthropicProvider   implementa Provider (agent-engine). Compone un AnthropicClient y le
                    agrega el loop de tool_use, MCP remoto, thinking/task budgets y
                    checkpointing — todo lo que sabe de "cómo correr UN Agent".
```

## Perillas — todas opcionales

| Opción | Qué hace | Default |
| --- | --- | --- |
La config de una corrida (`AnthropicRunConfig`) tiene **la misma estructura** en los dos niveles
donde se define: al registrar el provider (los defaults de todos sus agentes) y en el
`providerConfig` de cada agente, que la pisa clave por clave. Lo que ninguno define cae al
default del paquete (`RUN_CONFIG_DEFAULTS`).

| Opción | Qué hace | Default |
| --- | --- | --- |
| `model` | Modelo de la Messages API | — (obligatorio en el provider) |
| `maxTokens` | `max_tokens` de cada request | `1024` |
| `stream` | Streaming SSE (mantiene la conexión viva en runs largos) | `true` |
| `maxRetries` | Reintentos en 429/5xx/529 con backoff exponencial + jitter | `3` |
| `maxToolRounds` | Tope de vueltas del loop de tools (respuestas con `tool_use`) | `8` |
| `maxPauseTurnRetries` | Cuántas veces se reanuda un `pause_turn`; tope aparte de `maxToolRounds` | `3` |
| `bumpMaxTokensOnTruncation` | Un corte por `max_tokens` reintenta UNA vez con el doble de presupuesto | `true` |
| `thinking` | Extended thinking — `{ type: 'adaptive' }` o `{ type: 'enabled', budgetTokens }` | apagado |
| `thinkingBudgetTokens` | Atajo de ia-flow para `thinking: { type: 'enabled', budgetTokens }` (gana sobre `thinking`) | — |
| `effort` / `taskBudgetTokens` | `output_config` — nivel de esfuerzo / presupuesto total de tokens | apagado |
| `eagerMcpTools` | Carga el catálogo MCP entero de una, en vez de diferido con búsqueda | `false` |

Los defaults del paquete sirven para el caso simple. Un agente que trabaja sobre un repo (leer,
editar, correr tests, publicar) necesita bastante más: registrá el provider con sus propios
defaults.

```ts
providerRegistry.register(
  new AnthropicProvider({ id: 'anthropic-api', model: 'claude-sonnet-5', maxTokens: 32000, maxToolRounds: 200 }),
);

new Agent({
  id: 'x',
  provider: 'anthropic-api',
  prompt: '...',
  // Misma estructura: pisa lo del provider sólo para este agente.
  providerConfig: { model: 'claude-haiku-4-5-20251001', maxTokens: 512, maxToolRounds: 10 },
});
```

Una clave que no existe o con el tipo equivocado en el `providerConfig` hace fallar la corrida
antes de llamar a la API. `parseAnthropicAgentConfig(raw)` es el mismo chequeo, para que un runner
valide sus agentes al montarlos y falle en el boot. El `providerConfig` además acepta
`resumeMessages`, lo único que tiene sentido para una sola corrida.

Solo del provider (no se pisan por agente):

| Opción | Qué hace |
| --- | --- |
| `onCheckpoint(messages, ctx)` | Se llama antes de cada request — el caller decide si/dónde persistir |
| `onToolCall` / `onToolResult` | Observabilidad del loop de tools |
| `onRetry` | Observabilidad de los reintentos HTTP |
| `resolveOutcome(text)` | Deriva el `outcome` del texto final |

## Streaming incremental — `AnthropicClient.send`, no `AnthropicProvider`

`AnthropicProvider.run` sigue devolviendo el response completo recién al final (necesita
`content` entero para resolver `exit`/tool_use). Para un caso que sí quiere texto en vivo —
un chat — usá `AnthropicClient` directo, con `onDelta`:

```ts
import { AnthropicClient } from '@ia-flow/provider-anthropic-api';

const client = new AnthropicClient({}); // toma ANTHROPIC_API_KEY del entorno

const response = await client.send(
  { model: 'claude-sonnet-5', max_tokens: 1024, messages: [{ role: 'user', content: 'Hola' }] },
  {
    onDelta: (delta) => {
      if (delta.type === 'text') process.stdout.write(delta.delta); // fragmento, no acumulado
    },
  },
);
// `response` sigue siendo el mismo objeto reensamblado de siempre — onDelta es un canal aparte.
```

`onDelta` se llama con `text_delta`/`thinking_delta` a medida que llegan por SSE; se ignora si
`stream: false` (no hay nada que leer incremental). Ver `examples/apps/chat.ts` (en el repo
ia-tools, no migrado) para un chat de terminal completo con esto + tools + MCP remoto opcional.

## MCP remoto

`AgentDefinitionProps.mcpServers` (id + `config` libre) mapea a `mcp_servers[]` de la API cuando
`config.url` está presente — es el conector MCP **remoto** de Anthropic (Anthropic abre la
conexión, no este paquete); `stdio` no cruza la red y no está soportado acá.

```ts
new Agent({
  id: 'x',
  provider: 'anthropic-api',
  prompt: '...',
  mcpServers: [{ id: 'gh', config: { url: 'https://mcp.example/gh', authorizationToken: 'tok' } }],
});
```

## Checkpointing y reanudación

Este paquete no tiene storage propio — `onCheckpoint` es sólo un canal. El caller que quiera
reanudar un run pausado/cortado:

1. Persiste `messages` en `onCheckpoint(messages, ctx)`.
2. En el próximo run, pasa esa conversación de vuelta vía
   `providerConfig: { resumeMessages: [...] }` — `AnthropicProvider` arranca de ahí en vez de
   `ctx.prompt`.

Un `stop_reason: 'pause_turn'` (el modelo se pausó a mitad de turno) no se reanuda solo dentro de
una sola llamada a `run` — tira un error explícito en vez de adivinar. Reanudarlo es
responsabilidad del caller, con el mismo mecanismo de arriba.

## Lo que NO porta de ia-flow (a propósito)

- **`ToolExecutionPort`/`WorkspaceProvisionerPort`/policy compilada** — `agent-engine` no
  modela worktrees ni un compilador de allow/deny; las `tools[]` de un `Agent` ya vienen
  resueltas.
- **Contexto a disco (`logContext`)** — sin logger port en este harness; usá `onToolCall`/
  `onToolResult`/`onRetry` si necesitás observabilidad.
- **`retryTruncatedToolUse` fino** (reintento específico de un `tool_use` con JSON cortado a
  mitad de streaming) — `bumpMaxTokensOnTruncation` cubre el caso general (doblar presupuesto),
  no la reconstrucción puntual del bloque.
