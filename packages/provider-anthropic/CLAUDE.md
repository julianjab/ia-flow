# @ia-flow/provider-anthropic

`Provider` de Anthropic para `@ia-flow/agent-engine`, portado de
`packages/ai-providers/src/anthropic-api` del ia-flow v1 (ya purgado). Ver `README.md` para el contrato de uso;
esto es guía específica para trabajar en el código del paquete.

## Qué es este paquete

Es infra CONCRETA (a diferencia de `agent-engine`, que es contrato puro): hace `fetch` real
contra `https://api.anthropic.com`, lee `process.env`, maneja retries de red. Depende de
`@ia-flow/agent-engine` (implementa su `Provider`), nunca al revés — si algún día hiciera
falta que `agent-engine` supiera algo de este paquete, es señal de que ese algo pertenece en
`agent-engine/src/` como contrato, no acá.

## Estructura

```
src/
├── AnthropicClient.ts   clase AnthropicClient — auth + headers + retry + streaming.
│                         Reusable sola, sin saber nada de tools/agentes.
├── AnthropicProvider.ts  clase AnthropicProvider (implementa Provider) — compone un
│                         AnthropicClient y le agrega el loop de tool_use, MCP remoto,
│                         thinking/task budgets, checkpointing.
├── tracing.ts            qué deja el provider en la traza — opciones de @traced para `send`
│                         (`chat <model>`) y `executeTool` (`execute_tool <name>`).
├── sse.ts                reensamblado de streaming SSE → misma forma que un response
│                         no-streaming. Funciones puras, detalle de implementación de
│                         AnthropicClient (no se exporta).
├── index.ts
└── tests/                AnthropicClient.test.ts, AnthropicProvider.test.ts, sse.test.ts
```

## Por qué dos clases y no una

`AnthropicClient` no sabe qué es un `Tool`, un `Agent` ni un loop — sólo sabe hablar el wire
protocol (headers, retry, SSE). Es la pieza que usaría cualquier OTRO caller que necesite pegarle
a la API sin todo el aparato de `AnthropicProvider` (ej. un clasificador liviano de una sola
vuelta, sin tools). `AnthropicProvider` es la que sabe de `ProviderRunContext`/`ProviderRunOutput`
(el contrato de `agent-engine`) y arma el loop de tool_use sobre ese `AnthropicClient`.

Si necesitás agregar algo que es puramente "cómo le hablamos a la API" (un header nuevo, un modo
de retry distinto), va en `AnthropicClient`. Si es "cómo interpretamos la respuesta para un
`Agent`" (un `stop_reason` nuevo, cómo se arma el loop de tools), va en `AnthropicProvider`.

`AnthropicClient.send` soporta streaming incremental vía `onDelta` (llamado con cada
`text_delta`/`thinking_delta`, no el acumulado) — vive en `sse.ts`
(`readAnthropicSseStream(res, onDelta)`), no en `AnthropicProvider`: éste necesita el `content`
completo para resolver `stop_reason`/tool_use/exit, así que expone observabilidad batch
(`onToolCall`/`onToolResult`) pero no un `onDelta` propio. Un caller que quiera texto en vivo
(un chat) usa `AnthropicClient` directo — ver `README.md` y `examples/apps/chat.ts` (en el repo ia-tools, no migrado).

## Telemetría — spans GenAI, sólo por API

`AnthropicProvider` instrumenta sólo con `@ia-flow/telemetry` (sin SDK: no-op; no depende de
`@opentelemetry/api` salvo en los tests): `@traced` sobre `send` y `executeTool` — lo que
registran vive en `tracing.ts`, el loop no toca spans — y el campo
`readonly log = createLogger('provider-anthropic')` para los logs y los errores que se escapan.
Cada span y log hereda el scope del evento (`ia.issue`, `ia.repo`, …) y cuelga del paso del
agente sin plumbing:

- `chat <model>` por request a la API (kind CLIENT), con las convenciones GenAI:
  `gen_ai.request.model`, `gen_ai.usage.*_tokens` (incluidos los de cache),
  `gen_ai.response.finish_reasons`. Un reintento por `max_tokens` es otro span.
- Lo que el modelo hizo server-side (MCP remoto: `mcp_tool_use`/`mcp_tool_result`) y su texto van
  como EVENTOS de ese span — no corren acá, así que no tienen duración propia que medir.
- `execute_tool <name>` por tool local, en ERROR si devolvió `is_error` (el loop sigue igual).

`onToolCall`/`onToolResult` siguen existiendo para un caller sin OTel (ej. imprimir en consola).

## Ciclo de dependencias con `agent-engine` — por qué los examples NO viven acá ni ahí

Este paquete depende de `@ia-flow/agent-engine` (implementa su `Provider`). Si
`agent-engine` a su vez dependiera de este paquete —aunque sea sólo en `devDependencies`, para
sus propios examples— sería una dependencia cíclica entre workspaces. Por eso las apps de ejemplo
que combinan los dos paquetes (`github-issue-triage.ts`, `slack-support-reply.ts`,
`travel-planner.ts`) quedaron en el repo ia-tools (`examples/`, gitignoreado, no migrados) — un
tercer lugar que depende de ambos sin que ninguno dependa del otro. En ia-flow ese tercer lugar es
`apps/runner-v2`.

## Tests — mismo esquema que `agent-engine`

`src/*/tests/` al lado de lo que prueban (acá todo vive en `src/tests/` porque no hay
subcarpetas). `vitest.config.ts` mira `src/**/tests/**/*.test.ts`.

Los tests de `AnthropicProvider`/`AnthropicClient` NUNCA pegan a la red real: `fetchImpl` es
inyectable (`AnthropicClientOptions.fetchImpl`) y todos los tests pasan un `vi.fn()` que arma un
`Response` de `node-fetch`/`undici` a mano. `sse.test.ts` construye un `ReadableStream` con
frames SSE crudos para probar `readAnthropicSseStream` sin pasar por HTTP en absoluto.

## Antes de tocar código

```bash
bun run --filter @ia-flow/provider-anthropic typecheck
bun run --filter @ia-flow/provider-anthropic test
```

Source-only como `agent-engine`: sin build ni `dist/` — los `exports` apuntan a `src/*.ts`.
