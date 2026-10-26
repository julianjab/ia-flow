# llm-gateway

Un servidor local con la API de chat completions de OpenAI que contesta con Claude.

```bash
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  # el token real, sólo vive en este proceso
export LLM_GATEWAY_TOKEN=$(openssl rand -hex 24)  # lo que el cliente usa como "API key"
bun run gateway                              # http://127.0.0.1:4141
```

| Variable | Default | |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | — (requerida) | token OAuth de Claude (`claude setup-token`) |
| `LLM_GATEWAY_TOKEN` | — (requerida, ≥16 chars) | bearer que exige el gateway (también se acepta como `x-api-key`) |
| `LLM_GATEWAY_HOST` / `LLM_GATEWAY_PORT` | `127.0.0.1` / `4141` | dónde escucha |
| `LLM_GATEWAY_MODELS` | `claude-sonnet-5-5,claude-opus-5-5,claude-haiku-5-5` | lo que lista `/v1/models` |
| `LLM_GATEWAY_DEFAULT_MODEL` | el primero de la lista | si el request no trae `model` |
| `LLM_GATEWAY_MAX_TOKENS` | `4096` | Anthropic exige `max_tokens`; OpenAI no |
| `LLM_GATEWAY_DROP_SAMPLING` | `false` | `1`/`true` descarta `temperature` y `top_p` (modelos que los rechazan) |
| `LLM_GATEWAY_LOG_BODY` | `false` | `1`/`true` imprime el request completo (headers con su valor, incluido `Authorization`, y body) antes de la auth, y el request real que sale hacia Anthropic (URL, headers con la credencial enmascarada y body, también cada reintento): sólo para depurar |
| `LLM_GATEWAY_SYSTEM_PROMPT` | — (opcional) | se inserta como primer mensaje `system` de lo que manda el cliente; vacío = nada |

## Endpoints

- `GET /health` (sin auth) · `GET /v1/models` · `POST /v1/chat/completions` (con `stream` y tools).
- **Protocolo nativo de Anthropic:** `POST /v1/messages`, o `POST /v1/chat/completions` con el header
  `anthropic-version` (así lo manda iTerm2 con `API: Anthropic`). El body y el SSE de respuesta se
  reenvían tal cual; el gateway sólo antepone `LLM_GATEWAY_SYSTEM_PROMPT`, aplica los defaults de
  modelo y `max_tokens` y descarta `temperature`/`top_p` si `LLM_GATEWAY_DROP_SAMPLING`. El token del
  gateway va en `x-api-key`; a Anthropic siempre sale la credencial del gateway.

## iTerm2

Settings > General > AI > **Manage AI Models…**: agregá un modelo con la URL
`http://127.0.0.1:4141/v1/chat/completions`, el nombre de un modelo de la lista y tipo OpenAI
Chat Completions. Como API key, el `LLM_GATEWAY_TOKEN`.

## Cloud Run

`.github/workflows/deploy-gateway.yml` lo publica en Cloud Run en cada push a `main` que lo toque
(o a mano con *Run workflow*): typecheck + tests, `bun run bundle`, la imagen de
[`deploy/Dockerfile`](deploy/Dockerfile) y `gcloud run deploy`. Para uso propio: una instancia, a
cero sin tráfico, dentro del free tier.

Una sola vez, con una cuenta de facturación abierta (`gcloud billing accounts list`):

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... \
LLM_GATEWAY_TOKEN=$(openssl rand -hex 24) \
  apps/llm-gateway/deploy/setup-gcp.sh <project-id> <billing-account-id>
```

Crea el proyecto, los secretos en Secret Manager, las service accounts, la federación con GitHub
(sin keys JSON, sólo `main` de este repo) y las variables `GCP_*` del repo. Sin esas variables el
workflow no corre. Rotar un token = volver a correr el script con el valor nuevo y redeployar.

El servicio es público (`--allow-unauthenticated`): lo único que lo protege es
`LLM_GATEWAY_TOKEN`. La URL (`https://llm-gateway-….run.app`) la imprime el job al final.

## Límites

- `temperature` se recorta a 1 (OpenAI acepta hasta 2, Anthropic hasta 1).
- Sin embeddings, audio ni `response_format`; las imágenes van como `data:` URL o URL.
- Cortar la conexión no cancela el request a Anthropic: el cliente no soporta abort todavía.
