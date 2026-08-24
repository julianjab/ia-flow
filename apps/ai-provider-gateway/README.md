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

## Providers de terminal (`tmux-claude`, `iterm-claude`)

Son `kind: 'async'`: en vez de devolver el resultado, lanzan una sesión de
Claude en ESTA máquina y el agente reporta el final llamando de vuelta al
daemon que originó el dispatch. Correrlos detrás de un gateway pedía resolver
dos cosas que no cruzan una frontera de red por sí solas.

**Cómo vuelve el agente.** `terminal/base.ts` derivaba la URL del daemon de su
propio entorno (`http://localhost:$PORT`). Acá eso apunta al gateway — cuyo
PORT es 3002 — así que el agente habría arrancado con sus tools apuntadas a
`http://localhost:3002/api/mcp`, que no existe: sin ninguna tool y sin poder
cerrar su trabajo, en silencio. Ahora la URL viaja en `ProviderInput.daemonUrl`
y la completa `RemoteAgentProvider` con `IA_FLOW_DAEMON_PUBLIC_URL` (espejo de
`IA_FLOW_GATEWAY_PUBLIC_URL`, y por el mismo motivo: nadie deduce por qué
dirección lo ve el otro). Un run local no cambia — sin ese campo, el default de
siempre.

**La sesión.** `ProviderOutput.session` trae funciones (`isAlive`, `close`) que
el orquestador usa para el watchdog y el cancel, y que se pierden al
serializar. El gateway guarda el handle vivo y lo expone:

    GET    /v1/sessions/:id   → { alive, known }
    DELETE /v1/sessions/:id   → cierra la sesión

`RemoteAgentProvider` reconstruye un handle contra esos endpoints. Dos
criterios que importan:

- **Una sesión desconocida se reporta muerta, no 404.** Para el watchdog
  significan lo mismo, y pasa de verdad si el gateway reinició mientras corría.
- **Si no se puede preguntar, se asume VIVA.** Decir "muerta" ante un error de
  red haría que el watchdog cierre un run que quizás sigue trabajando; un run
  colgado se nota, uno cerrado de más se perdió.

**`iterm-claude` necesita sesión gráfica.** En un gateway headless o dentro de
un container no va a funcionar aunque el cableado esté bien; `tmux-claude` sí.

## La pantalla — `GET /`

Abrí `http://localhost:3002/` en el navegador. Muestra el provider (kind,
nombre, descripción) y la capacidad (runs en curso, tope, si admite y por qué
no), y desde ahí se edita lo que antes sólo vivía en el `.env`:

- **Contra qué servers está registrado** — agregar uno lo da de alta ahí
  mismo (`POST /v1/registrations`), la × lo da de baja
  (`DELETE /v1/registrations?serverUrl=`). La lista se guarda: al reiniciar,
  el gateway se registra en esos y ya no mira
  `IA_FLOW_REGISTER_SERVER_URLS`. Cada fila muestra si el alta **funcionó** y,
  si no, el motivo que devolvió el server.

  **Alcanza con la URL del server.** Por dónde ese server te alcanza a vos es
  una segunda pregunta, en la dirección opuesta, y no se puede deducir de la
  primera: `localhost:3011` puede ser un proceso del host o un puerto
  publicado por un container, y desde afuera se ven igual. Pero el fallo sí es
  inequívoco — el server valida alcanzándote y responde `400: no se pudo
  alcanzar <url>` — así que en vez de pedirte el dato se prueba: si
  `localhost` no sirve, se reintenta con `host.containers.internal` y
  `host.docker.internal`. La fila muestra con cuál quedó.

  Un host que no sea local (una IP, un nombre propio) no se reescribe: eso es
  una decisión deliberada de quien la puso. Y `POST /v1/registrations` sigue
  aceptando `publicUrl` para forzarla.

  Bajo una registración exitosa aparece **"me alcanza en …"**: es el `baseUrl`
  con el que este gateway quedó anunciado, o sea la dirección que ese server
  va a usar para mandarle trabajo (`GET /v1/provider`, `POST /v1/run`).

  Si la URL que ponés no es la de un server de ia-flow —el error clásico es
  poner la del gateway, que contesta `401` a todo— se dice con esas palabras y
  **no se recuerda**: reintentarla en cada arranque no cambiaría nada y sólo
  dejaría filas rojas para limpiar a mano.
- **Qué provider expone** — `anthropic-api`, `claude-print`, `tmux-claude` o
  `iterm-claude`, con un selector
  en la tarjeta *provider*. Cambia **sin reiniciar**: un run en curso termina
  con el que le tocó (su `provider.run()` ya fue invocado), y el cambio aplica
  a los siguientes. Al cambiar, los servers donde está registrado se vuelven a
  dar de alta: guardaron nombre y descripción cuando se registró, y sin eso
  seguirían anunciando el provider viejo — el operador vería en la web del
  server algo distinto de lo que este gateway ejecuta.
- **Cuándo acepta trabajo** — el tope de runs en paralelo y reglas sobre la
  tarea que llega (`repo`, `agentId`, `projectId`, `taskType`), con
  `es / no es / matchea / no matchea` y `*` como comodín. Todas tienen que
  cumplirse.

**Lo guardado gana sobre el env.** `GATEWAY_PROVIDER`,
`GATEWAY_MAX_CONCURRENT_RUNS` e `IA_FLOW_REGISTER_SERVER_URLS` son el arranque
en frío (la primera vez, o un
docker-compose); apenas elegís algo en la pantalla, eso es lo que manda. El
estado vive en `$IA_FLOW_CONFIG_DIR/gateway.json`
(`IA_FLOW_GATEWAY_STATE_FILE` lo mueve).

### Dónde se aplica cada regla

Una regla sobre un campo que la tarea no trae **no rechaza**. Importa porque
`GET /v1/capacity` es una sonda sin cuerpo: rechazar ahí por falta de dato
dejaría al daemon difiriendo el issue para siempre contra un gateway que en
realidad lo hubiera tomado. El daemon manda lo que sabe como query
(`?repo=&agentId=&projectId=&taskType=`) para poder filtrar antes del
dispatch, y el filtro completo corre en `POST /v1/run`, que sí tiene la tarea
entera y responde **503** — o sea "volvé después", que el daemon difiere en
vez de marcar el run como fallado.

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
