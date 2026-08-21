# ai-provider-gateway

App standalone que expone UN provider de IA (anthropic-api o claude-print,
elegido internamente vía `GATEWAY_PROVIDER`) por HTTP, para que el server
principal de ia-flow lo registre como "un provider más" sin saber ni elegir
qué corre detrás — esa decisión es 100% interna a esta instancia.

Hermana de [`apps/agent-runner`](../agent-runner/README.md): esa es la app
de **runner** (corre un roster de agentes completo contra un proyecto).
Esta es la app de **provider** (solo ejecuta el modelo cuando alguien se lo
pide — el server principal, un runner remoto, lo que sea). Juntas cubren los
dos roles que alguien externo al server principal puede tomar.

## Levantarla

```bash
cd apps/ai-provider-gateway
API_AI_PROVIDER_TOKEN=algo-random ANTHROPIC_API_KEY=sk-... bun run dev
# o: bun run start
```

Env vars:

- `API_AI_PROVIDER_TOKEN` — bearer token que vos elegís; el server principal
  lo usa para autenticarse contra este gateway. Sin esto, TODO se rechaza
  con 500 (nunca "sin auth").
- `ANTHROPIC_API_KEY` o `CLAUDE_CODE_OAUTH_TOKEN` — para que
  `AnthropicApiProvider`/`ClaudePrintProvider` puedan correr.
- `GATEWAY_PROVIDER` — `anthropic-api` (default) o `claude-print`. Cuál de
  los dos expone esta instancia — ver `src/providers.ts`.
- `PORT` (opcional, default `3002`).

Endpoints (todos requieren `Authorization: Bearer <API_AI_PROVIDER_TOKEN>`):

- `GET /v1/provider` — describe el provider que expone esta instancia
  (`{ kind, name, description }`). Lo usa el server principal para validar
  la registración antes de guardarla.
- `POST /v1/run` — corre el provider con un `ProviderInput` en el body y
  devuelve el `ProviderOutput`.

## Registrarla en el server principal

```bash
curl -X POST http://<server-principal>/api/provider-registrations \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "mi-maquina",
    "baseUrl": "http://<url-del-gateway-o-túnel>",
    "token": "algo-random"
  }'
```

El server valida contra `GET /v1/provider` de tu gateway
(`fetchGatewayProvider`) y, si responde, guarda la registración e instancia
un `RemoteAgentProvider` que a partir de ahí delega cada `run` a tu máquina
vía `POST /v1/run` — el server nunca sabe cómo se ejecuta.

Si el server principal no está en la misma red que tu gateway, exponelo con
un túnel corrido a mano (`cloudflared tunnel --url http://localhost:3002`,
ngrok, etc.) y usá esa URL como `baseUrl`.
