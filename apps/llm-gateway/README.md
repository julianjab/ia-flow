# llm-gateway

Un servidor local con la API de chat completions de OpenAI que contesta con Claude.

```bash
export ANTHROPIC_API_KEY=sk-ant-...          # la key real, sólo vive en este proceso
export LLM_GATEWAY_TOKEN=$(openssl rand -hex 24)  # lo que el cliente usa como "API key"
bun run gateway                              # http://127.0.0.1:4141
```

| Variable | Default | |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — (requerida) | key de Anthropic |
| `LLM_GATEWAY_TOKEN` | — (requerida, ≥16 chars) | bearer que exige el gateway |
| `LLM_GATEWAY_HOST` / `LLM_GATEWAY_PORT` | `127.0.0.1` / `4141` | dónde escucha |
| `LLM_GATEWAY_MODELS` | `claude-sonnet-5-5,claude-opus-5-5,claude-haiku-5-5` | lo que lista `/v1/models` |
| `LLM_GATEWAY_DEFAULT_MODEL` | el primero de la lista | si el request no trae `model` |
| `LLM_GATEWAY_MAX_TOKENS` | `4096` | Anthropic exige `max_tokens`; OpenAI no |
| `LLM_GATEWAY_SYSTEM_PROMPT` | — (opcional) | se antepone al `system` del cliente; vacío = nada |

## Endpoints

- `GET /health` (sin auth) · `GET /v1/models` · `POST /v1/chat/completions` (con `stream` y tools).

## iTerm2

Settings > General > AI > **Manage AI Models…**: agregá un modelo con la URL
`http://127.0.0.1:4141/v1/chat/completions`, el nombre de un modelo de la lista y tipo OpenAI
Chat Completions. Como API key, el `LLM_GATEWAY_TOKEN`.

## Límites

- `temperature` se recorta a 1 (OpenAI acepta hasta 2, Anthropic hasta 1).
- Sin embeddings, audio ni `response_format`; las imágenes van como `data:` URL o URL.
- Cortar la conexión no cancela el request a Anthropic: el cliente no soporta abort todavía.
