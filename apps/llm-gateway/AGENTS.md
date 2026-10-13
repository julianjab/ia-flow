# apps/llm-gateway

Servidor local compatible con la API de chat completions de OpenAI que responde con Claude, usando
`AnthropicClient` de `@ia-flow/provider-anthropic-api`. Sirve para apuntar clientes
OpenAI-compatibles (el chat de iTerm2, editores, scripts) a Claude con una key propia.

## Estructura

- `main.ts` — composition root: entorno → config → cliente → `Bun.serve`. Nadie lo importa.
- `handler.ts` — `(Request) → Response`: auth, rutas (`/health`, `/v1/models`,
  `/v1/chat/completions`) y SSE. Recibe el puerto `send` hacia Anthropic; no conoce la red.
- `anthropicRoute.ts` — protocolo nativo de Anthropic: detecta el request, antepone el system prompt y
  reenvía la `Response` cruda (SSE incluido) por el puerto `forward`. Lo pura es `prepareAnthropicBody`.
- `gatewayLog.ts` — el puerto de logs que el handler necesita.
- `openaiToAnthropic.ts` — request de OpenAI → body de la Messages API. Pura.
- `anthropicToOpenai.ts` — respuesta/chunks/errores de Anthropic → formato OpenAI. Pura.
- `config.ts` — parseo y validación del entorno. Pura.

## Reglas

- **Escucha sólo en `127.0.0.1` por default y exige `LLM_GATEWAY_TOKEN`.** No quites ninguna de
  las dos sin una razón explícita: el gateway gasta la key de quien lo corre.
- **La key de Anthropic va explícita al cliente**, nunca por el fallback del entorno (que prefiere
  `CLAUDE_CODE_OAUTH_TOKEN`).
- No se loguea el contenido de los mensajes, sólo método, ruta, status y duración. Única excepción:
  `LLM_GATEWAY_LOG_BODY=true`, opt-in explícito para depurar un cliente: imprime headers (con el
  token) y body.
- Tests al lado del módulo (`<módulo>.test.ts`, `bun test`), con un `send` falso: nunca la red real.
