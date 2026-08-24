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

## La pantalla — `GET /`

Abrí `http://localhost:3002/` en el navegador para ver qué expone este
gateway: el provider (kind, nombre, descripción) y su capacidad (runs en
curso, tope, si está admitiendo y por qué no).

Se sirve **sin auth a propósito**: la página es HTML pelado, sin un solo dato
adentro. Te pide el `API_AI_PROVIDER_TOKEN`, lo guarda en el localStorage de
ese navegador y consulta `/v1/provider` y `/v1/capacity` como lo haría el
daemon — sin token no muestra más que un formulario, así que exponerla no
abre nada que el 401 protegía. El resto de las rutas siguen pidiendo el
bearer igual que antes.

Es un string en `src/ui.ts`, sin build ni assets: este proceso se levanta
suelto en cualquier máquina y meterle un bundler para una página de dos
tarjetas sería más infraestructura que producto. Los colores se copian a mano
de `apps/web/src/styles/theme.css` para no atar el gateway al build de la SPA.

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

### Sola, al bootear (recomendado)

Seteá estos 3 env vars además de los de arriba y el gateway se da de alta
solo contra uno o más servers apenas levanta (`src/register.ts`,
`registerSelf`, llamado al final de `src/index.ts`):

- `IA_FLOW_REGISTER_SERVER_URLS` — uno o más `baseUrl` de servers ia-flow,
  separados por coma (ej. `http://localhost:3001` o
  `http://localhost:3001,http://otro-server:3001`).
- `IA_FLOW_GATEWAY_PUBLIC_URL` — el `baseUrl` por el que ESE server llega a
  este gateway (no necesariamente el mismo host:puerto en el que escucha —
  ver notas de red más abajo).
- `IA_FLOW_PROVIDER_NAME` — el `name` de la registración (ej.
  `julianbuitrago-mac`).

```bash
cd apps/ai-provider-gateway
API_AI_PROVIDER_TOKEN=algo-random \
CLAUDE_CODE_OAUTH_TOKEN=... \
IA_FLOW_REGISTER_SERVER_URLS=http://localhost:3001 \
IA_FLOW_GATEWAY_PUBLIC_URL=http://localhost:3002 \
IA_FLOW_PROVIDER_NAME=mi-maquina \
bun run dev
```

Es idempotente por boot: antes de crear la registración nueva, borra
cualquier registración previa con el MISMO `name` en ese server — reiniciar
el gateway (nuevo proceso, mismo `name`) no deja filas viejas apuntando a un
`baseUrl`/token que ya no valen. Un server caído o inalcanzable solo loguea
un warning — no tumba el boot ni frena el registro contra el resto de
`IA_FLOW_REGISTER_SERVER_URLS`.

Notas de red: `IA_FLOW_REGISTER_SERVER_URLS` tiene que ser alcanzable DESDE
donde corre el gateway (típicamente `localhost:<puerto-del-server>` si están
en la misma máquina). Esto NO funciona si el server vive dentro de un
container que no publica su puerto de API al host (ver
`apps/agent-runner/README.md` — el `:3001` de esas instancias es privado a
propósito) — en ese caso, o publicá ese puerto en un puerto de host libre
(ver `runners/subscriptions-pipeline/docker-compose.yml` — publica su API en
`127.0.0.1:3011` justo para esto), o seguí registrando a mano desde adentro
del container (sección de abajo).

Ejemplo concreto de este setup (gateway en el host, server target en un
container): `runners/subscriptions-pipeline` — `IA_FLOW_REGISTER_SERVER_URLS=
http://localhost:3011` (host → container, vía el puerto publicado) e
`IA_FLOW_GATEWAY_PUBLIC_URL=http://host.containers.internal:3002` (container
→ host, vía la resolución de Podman).

### A mano (curl)

```bash
curl -X POST http://<server-principal>/api/provider-registrations \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "mi-maquina",
    "baseUrl": "http://<url-del-gateway-o-túnel>",
    "token": "algo-random"
  }'
```

Para un server que corre en un container sin el puerto de API publicado
(ej. una instancia de `apps/agent-runner`), corré el mismo `curl` desde
ADENTRO del container: `podman exec <container> curl ...` con `baseUrl`
apuntando a `http://host.containers.internal:<puerto-del-gateway>`.

En ambos casos, el server valida contra `GET /v1/provider` de tu gateway
(`fetchGatewayProvider`) y, si responde, guarda la registración e instancia
un `RemoteAgentProvider` que a partir de ahí delega cada `run` a tu máquina
vía `POST /v1/run` — el server nunca sabe cómo se ejecuta.

Si el server principal no está en la misma red que tu gateway, exponelo con
un túnel corrido a mano (`cloudflared tunnel --url http://localhost:3002`,
ngrok, etc.) y usá esa URL como `baseUrl`/`IA_FLOW_GATEWAY_PUBLIC_URL`.
