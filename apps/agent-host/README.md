# agent-host

App standalone que expone UN provider de IA (anthropic-api o claude-print,
elegido internamente vía `AGENT_HOST_PROVIDER`) por HTTP, para que el server
principal de ia-flow lo registre como "un provider más" sin saber ni elegir
qué corre detrás — esa decisión es 100% interna a esta instancia.

Hermana del [flavor `runner`](../server/RUNNER-DEPLOY.md): esa es la app
de **runner** (corre un roster de agentes completo contra un proyecto).
Esta es la app de **provider** (solo ejecuta el modelo cuando alguien se lo
pide — el server principal, un runner remoto, lo que sea). Juntas cubren los
dos roles que alguien externo al server principal puede tomar.

## Providers de terminal (`tmux-claude`, `iterm-claude`)

Son `kind: 'async'`: en vez de devolver el resultado, lanzan una sesión de
Claude en ESTA máquina y el agente reporta el final llamando de vuelta al
daemon que originó el dispatch. Correrlos detrás de un agent-host pedía resolver
dos cosas que no cruzan una frontera de red por sí solas.

**Cómo vuelve el agente.** `terminal/base.ts` derivaba la URL del daemon de su
propio entorno (`http://localhost:$PORT`). Acá eso apunta al agent-host — cuyo
PORT es 3002 — así que el agente habría arrancado con sus tools apuntadas a
`http://localhost:3002/api/mcp`, que no existe: sin ninguna tool y sin poder
cerrar su trabajo, en silencio.

Ahora viaja en `ProviderInput.daemonUrl`, y **normalmente no hay que
configurar nada**: el agent-host la completa con la URL con la que se registró,
que por definición funciona desde esta máquina porque el alta viajó por ella.
El server no podría deducirla —`localhost` para él es él mismo— pero el
agent-host ya la tiene medida.

La excepción es un agent-host registrado en **varios** servers: ahí no hay forma
de saber cuál despachó este run, así que se respeta lo que haya mandado el
server. Para ese caso el daemon puede declarar `IA_FLOW_DAEMON_PUBLIC_URL`
(espejo de `IA_FLOW_AGENT_HOST_PUBLIC_URL`); si no lo hace, cae a su `localhost`
y los runs de terminal remotos no van a encontrar sus tools.

Un run local no cambia — sin ese campo, el default de siempre.

**La sesión.** `ProviderOutput.session` trae funciones (`isAlive`, `close`) que
el orquestador usa para el watchdog y el cancel, y que se pierden al
serializar. El agent-host guarda el handle vivo y lo expone:

    GET    /v1/sessions/:id   → { alive, known }
    DELETE /v1/sessions/:id   → cierra la sesión

`RemoteAgentProvider` reconstruye un handle contra esos endpoints. Dos
criterios que importan:

- **Una sesión desconocida se reporta muerta, no 404.** Para el watchdog
  significan lo mismo, y pasa de verdad si el agent-host reinició mientras corría.
- **Si no se puede preguntar, se asume VIVA.** Decir "muerta" ante un error de
  red haría que el watchdog cierre un run que quizás sigue trabajando; un run
  colgado se nota, uno cerrado de más se perdió.

**`iterm-claude` necesita sesión gráfica.** En un agent-host headless o dentro de
un container no va a funcionar aunque el cableado esté bien; `tmux-claude` sí.

## La pantalla — `GET /`

Abrí `http://localhost:3002/` en el navegador. Muestra el provider (kind,
nombre, descripción) y la capacidad (runs en curso, tope, si admite y por qué
no), y desde ahí se edita lo que antes sólo vivía en el `.env`:

- **Contra qué servers está registrado** — agregar uno lo da de alta ahí
  mismo (`POST /v1/registrations`), la × lo da de baja
  (`DELETE /v1/registrations?serverUrl=`). La lista se guarda: al reiniciar,
  el agent-host se registra en esos y ya no mira
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
  con el que este agent-host quedó anunciado, o sea la dirección que ese server
  va a usar para mandarle trabajo (`GET /v1/provider`, `POST /v1/run`).

  Si la URL que ponés no es la de un server de ia-flow —el error clásico es
  poner la del agent-host, que contesta `401` a todo— se dice con esas palabras y
  **no se recuerda**: reintentarla en cada arranque no cambiaría nada y sólo
  dejaría filas rojas para limpiar a mano.
- **Qué provider expone** — `anthropic-api`, `claude-print`, `tmux-claude` o
  `iterm-claude`, con un selector
  en la tarjeta *provider*. Cambia **sin reiniciar**: un run en curso termina
  con el que le tocó (su `provider.run()` ya fue invocado), y el cambio aplica
  a los siguientes. Al cambiar, los servers donde está registrado se vuelven a
  dar de alta: guardaron nombre y descripción cuando se registró, y sin eso
  seguirían anunciando el provider viejo — el operador vería en la web del
  server algo distinto de lo que este agent-host ejecuta.
- **Cuándo acepta trabajo** — el tope de runs en paralelo y reglas sobre la
  tarea que llega (`repo`, `agentId`, `projectId`, `taskType`), con
  `es / no es / matchea / no matchea` y `*` como comodín. Todas tienen que
  cumplirse.

**Lo guardado gana sobre el env.** `AGENT_HOST_PROVIDER`,
`AGENT_HOST_MAX_CONCURRENT_RUNS` e `IA_FLOW_REGISTER_SERVER_URLS` son el arranque
en frío (la primera vez, o un
docker-compose); apenas elegís algo en la pantalla, eso es lo que manda. El
estado vive en `$IA_FLOW_CONFIG_DIR/agent-host.json`
(`IA_FLOW_AGENT_HOST_STATE_FILE` lo mueve).

### Dónde se aplica cada regla

Una regla sobre un campo que la tarea no trae **no rechaza**. Importa porque
`GET /v1/capacity` es una sonda sin cuerpo: rechazar ahí por falta de dato
dejaría al daemon difiriendo el issue para siempre contra un agent-host que en
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
de `apps/web/src/styles/theme.css` para no atar el agent-host al build de la SPA.

## La config — `agent-host.yaml`

Hermana del `runner.yaml` del flavor `runner`, con su misma regla: **secreto →
env; comportamiento → el archivo, que se commitea.** Ver
[`agent-host.example.yaml`](./agent-host.example.yaml).

```yaml
settings:
  provider: anthropic-api
  providerName: front-end-developer
  publicUrl: http://front-end-developer:3002
  maxConcurrentRuns: 2
register:
  servers: [http://ai-development-flow:3001]
workspace:
  reposBase: /state/repos
admission:
  rules:
    - { field: repo, op: equals, value: lh-seller-v2-frontend }
```

Se busca en `argv[2]`, después `AGENT_HOST_CONFIG`, después
`/app/config/agent-host.yaml`. Los dos primeros son **explícitos**: si no se
pueden leer, el proceso no arranca — pedir una config y arrancar sin ella deja
al agent-host sano en el health check y admitiendo trabajo que no le toca. El
tercero puede faltar, y ahí manda el entorno como siempre: sin archivo, nada
de esto cambia un deploy existente. Un archivo que existe pero no cumple el
schema tira siempre.

**Por qué existe, si ya había env vars y un `agent-host.json`.** Porque ese
JSON no es config: es estado que escribe la pantalla. Los dos alcanzan
mientras el agent-host vive en una laptop, donde hay alguien para abrirla. En
un deploy desatendido no hay nadie, y las reglas de admisión —lo único que
decide qué trabajo toma esta máquina— no tenían forma declarativa: un pod que
bootea con su volumen vacío arrancaba admitiendo **todo**.

Las tres capas, de menor a mayor precedencia:

| | Qué es | Gana sobre |
| --- | --- | --- |
| `agent-host.yaml` | lo que el deploy declara | — |
| env vars | el override puntual (`-e` para debuggear) | el YAML |
| `agent-host.json` | lo que el operador eligió en la pantalla | los dos |

Lo que el entorno haya pisado se nombra en la línea `agent-host ready` del
arranque, con el path del archivo que se cargó: un override silencioso deja
sin respuesta la pregunta "¿por qué no aplica lo que dice el YAML?".

## Levantarla

```bash
cd apps/agent-host
API_AI_PROVIDER_TOKEN=algo-random ANTHROPIC_API_KEY=sk-... bun run dev
# o: bun run start
```

Env vars:

- `API_AI_PROVIDER_TOKEN` — bearer token que vos elegís; el server principal
  lo usa para autenticarse contra este agent-host. Sin esto, TODO se rechaza
  con 500 (nunca "sin auth").
- `ANTHROPIC_API_KEY` o `CLAUDE_CODE_OAUTH_TOKEN` — para que
  `AnthropicApiProvider`/`ClaudePrintProvider` puedan correr.
- `AGENT_HOST_PROVIDER` — `anthropic-api` (default) o `claude-print`. Cuál de
  los dos expone esta instancia — ver `src/providers.ts`.
- `PORT` (opcional, default `3002`).
- `LOG_LEVEL` (opcional, default `info`).
- `IA_FLOW_LOG_DIR` / `IA_FLOW_CONFIG_DIR` / `IA_FLOW_AGENT_HOST_LOG_FILE`
  (opcionales) — dónde queda el archivo de log; ver abajo.
- `AGENT_HOST_MAX_CONCURRENT_RUNS` (opcional) — techo de runs simultáneos en
  ESTE proceso. Vacío o `0` = sin límite; ver "Capacidad" en el `CLAUDE.md`
  de la raíz.
- `AGENT_HOST_REPOS_BASE` (opcional) — dónde aterrizan los clones cuando un run
  pide un repo que esta máquina nunca vio (`resolveWorkspace` en `src/app.ts`).
- `OTEL_EXPORTER_OTLP_ENDPOINT` (opcional) — a qué collector OpenTelemetry
  mandar los logs. Vacío = apagado; ver abajo.

### En contenedor

`docker-compose.example.yml`, al lado de este README, levanta la imagen
esta app con todo esto ya cableado:

```bash
cp .env.example .env    # completar valores reales
podman compose -f docker-compose.example.yml up -d --build
```

**Preguntate antes si lo necesitás.** Para el uso normal `bun run dev` es más
simple —mismo proceso, logs en la terminal, sin rebuild al cambiar código—. El
contenedor gana cuando el agent-host no puede vivir en tu Mac: más RAM, una VM
cerca de los repos, o un host que **no se suspende**, que es la diferencia más
concreta — un agent-host dormido se cae del `ProviderRegistry` del server y sus
agentes pasan a diferirse (ver "Salud" en el `CLAUDE.md` de la raíz).

Tres cosas que muerden en ese modo:

- **El registro en frío exige `IA_FLOW_PROVIDER_NAME`**, además de la URL
  pública y el token: `identity()` (`src/register.ts`) pide las tres y sin una
  devuelve `null`. `registerWithServers` sale entonces por su `if (!id)` con un
  warn, así que el agent-host queda arriba **sin registrarse** — parece que anduvo.
- **`AGENT_HOST_REPOS_BASE` va dentro del volumen** (`/state/repos`), o cada
  restart vuelve a clonar todo.
- **La imagen no trae el CLI `claude`**, así que `claude-print`, `tmux-claude`
  e `iterm-claude` no arrancan sin instalarlo o montarlo desde el host.
  `anthropic-api` —el default, y el fallback garantizado de todo agente con
  `remote:*`— no lo necesita.

Lo que elijas desde la pantalla del agent-host **gana sobre las env vars** y
sobrevive al restart: las variables son sólo el arranque en frío (`src/state.ts`).

## Los logs

Van a **stdout** (pretty) y a **`~/.config/ia-flow/logs/agent-host.log`**
(JSON por línea), en paralelo. La línea `agent-host ready` del
arranque incluye el path exacto en `logFile`.

El archivo existe por cómo se levanta esto de verdad: `IA Flow AgentHost.app`
(`apps/desktop`) spawnea el agent-host y sólo repite su stdout al stdout de
Electron, que abierto desde el Finder **no va a ningún lado**. Sin archivo,
ver por qué falló un run pedía relanzar la app desde una terminal.

```bash
tail -f ~/.config/ia-flow/logs/agent-host.log
tail -f ~/.config/ia-flow/logs/agent-host.log | bunx pino-pretty
```

Es el mismo directorio que usa `apps/server` para su `daemon.log`, con
archivo aparte: un solo `IA_FLOW_LOG_DIR` mueve los dos procesos. La cadena
de defaults es la misma que la del state file: `IA_FLOW_AGENT_HOST_LOG_FILE`
(override completo) → `IA_FLOW_LOG_DIR` → `$IA_FLOW_CONFIG_DIR/logs` →
`~/.config/ia-flow/logs`.

Dos cosas deliberadas:

- **`IA_FLOW_AGENT_HOST_LOG_FILE=""` apaga el archivo** y deja sólo stdout. Es
  lo que hace el `Dockerfile`: en un container los logs los junta el runtime
  y escribir a un filesystem efímero es basura que nadie lee.
- **Si el directorio no se puede crear, se sigue sin archivo** en vez de
  morir en el import. Quedarse sin agent-host por no poder loguear sería peor
  que quedarse sin el log.

Lo que NO hace, a diferencia del server: reenviar a `IA_FLOW_REMOTE_LOG_URL`.
El agent-host no es un daemon de ia-flow, no tiene UI de logs que alimentar.

### Mandarlos a un collector OpenTelemetry

Un operador con varios agent-hosts —un container por roster, el
`IA Flow AgentHost.app` en la laptop, un runner en un host aparte— tiene hoy
que abrir un `agent-host.log` por máquina para contestar "¿por qué falla el
runner remoto?". El sink OTLP existe para no tener que hacer eso: los mismos
logs, correlacionados en un backend, seteando una env var.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 bun run dev
```

Es **opt-in**: con `OTEL_EXPORTER_OTLP_ENDPOINT` vacío no se construye ningún
`LoggerProvider` ni sale un solo request, y el agent-host se comporta
exactamente igual que antes de que esto existiera. Las vars que lo mueven:

- `OTEL_EXPORTER_OTLP_ENDPOINT` — el baseUrl del collector (los records van
  a su `/v1/logs`). Es el interruptor: vacío = apagado.
- `OTEL_SDK_DISABLED=true` — kill switch, apaga el sink aunque haya endpoint.
- `OTEL_SERVICE_NAME` — override del `service.name`, que por default es
  `ia-flow-agent-host`.
- `OTEL_DEPLOYMENT_ENVIRONMENT` — el `deployment.environment.name`, default
  `development`.
- `IA_FLOW_INSTANCE_ID` — quién es ESTE proceso en el collector
  (`service.instance.id`). Sin ella cae al pid, que alcanza para
  desambiguar dentro de una máquina pero no entre reinicios.
- `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_RESOURCE_ATTRIBUTES` — las estándar
  del SDK, para auth del collector y attrs propios del deploy.

**Suma, no reemplaza.** El pretty a stdout y `agent-host.log` siguen igual, y la
card *logs* de `GET /` sigue leyendo el archivo — el reader no se entera de
que OTel existe. Cada línea sale por los tres lados.

**Un collector caído no rompe nada.** Misma filosofía que el archivo: si el
endpoint está mal formado o el paquete no resuelve, el sink no se construye y
el agent-host arranca sin él; si el collector se cae en caliente, el
`BatchLogRecordProcessor` falla asincrónicamente y sus errores bajan a `debug`
en vez de ensuciar el pretty. Quedarse sin observabilidad es mejor que
quedarse sin agent-host.

El porqué de cada decisión —por qué un bridge propio y no
`pino-opentelemetry-transport`, por qué `multistream`, por qué OTLP/HTTP—
está en el ADR [`docs/prd/otel-logs.md`](../../docs/prd/otel-logs.md).

### El tail de la pantalla — `GET /v1/logs`

La card **logs** de `GET /` muestra el final del archivo con un filtro.
Detalles que no se deducen mirándola:

- **El filtro corre en el agent-host, sobre el archivo**, no en el navegador
  sobre lo ya bajado. Filtrar las últimas 200 líneas encontraría todos los
  errores salvo los viejos, que son justo los que uno busca. Por eso el
  endpoint toma `q` y no se resuelve del lado del cliente.
- **Todos los términos tienen que estar**: `error tmux` acota, no amplía.
- **`error` / `warn` / `info` matchean el nivel**, que en el archivo es un
  número (`"level":50`). Sin eso, la primera palabra que cualquiera tipea no
  encontraba una sola línea.
- **El resto matchea contra la línea cruda**, extras incluidos: buscar un
  `taskId` o un `sessionId` es la mitad de las búsquedas.
- **La ventana son los últimos 4 MB.** Si hay más historia, la pantalla lo
  dice en vez de mentir un "no hay resultados" — para eso está `grep`.
- **"seguir"** ata el autoscroll y el refresco del sondeo; scrollear hacia
  arriba lo destilda solo, que es la forma natural de decir "estoy leyendo".

Sin archivo (el caso del Dockerfile) el endpoint responde `file: null` y la
card lo dice: los logs están en el stdout del proceso.

Endpoints (todos requieren `Authorization: Bearer <API_AI_PROVIDER_TOKEN>`):

- `GET /v1/provider` — describe el provider que expone esta instancia
  (`{ kind, name, description }`). Lo usa el server principal para validar
  la registración antes de guardarla.
- `POST /v1/run` — corre el provider con un `ProviderInput` en el body y
  devuelve el `ProviderOutput`.
- `GET /v1/logs?limit=&q=` — el final del archivo de log, filtrado. Lo usa la
  card de logs de la pantalla; ver "Los logs" más arriba.

## Registrarla en el server principal

### Sola, al bootear (recomendado)

Seteá estos 3 env vars además de los de arriba y el agent-host se da de alta
solo contra uno o más servers apenas levanta (`src/register.ts`,
`registerSelf`, llamado al final de `src/index.ts`):

- `IA_FLOW_REGISTER_SERVER_URLS` — uno o más `baseUrl` de servers ia-flow,
  separados por coma (ej. `http://localhost:3001` o
  `http://localhost:3001,http://otro-server:3001`).
- `IA_FLOW_AGENT_HOST_PUBLIC_URL` — el `baseUrl` por el que ESE server llega a
  este agent-host (no necesariamente el mismo host:puerto en el que escucha —
  ver notas de red más abajo).
- `IA_FLOW_PROVIDER_NAME` — el `name` de la registración (ej.
  `julianbuitrago-mac`).
- `IA_FLOW_SERVER_TOKEN` (opcional) — la credencial con la que este
  agent-host se autentica contra la API de ese server, mandada como
  `x-ia-flow-token` en el alta, la baja y el listado. Hace falta cuando el
  server corre con `api: full`: su middleware es fail-closed y sólo exime
  `/api/webhooks/github`, así que sin esto el alta muere en `401`. Es el
  `IA_FLOW_API_TOKEN` de ese server. Sin la variable no se manda ningún
  header y un server sin auth sigue aceptando el alta como siempre.

```bash
cd apps/agent-host
API_AI_PROVIDER_TOKEN=algo-random \
CLAUDE_CODE_OAUTH_TOKEN=... \
IA_FLOW_REGISTER_SERVER_URLS=http://localhost:3001 \
IA_FLOW_AGENT_HOST_PUBLIC_URL=http://localhost:3002 \
IA_FLOW_PROVIDER_NAME=mi-maquina \
bun run dev
```

Es idempotente por boot: antes de crear la registración nueva, borra
cualquier registración previa con el MISMO `name` en ese server — reiniciar
el agent-host (nuevo proceso, mismo `name`) no deja filas viejas apuntando a un
`baseUrl`/token que ya no valen. Un server caído o inalcanzable solo loguea
un warning — no tumba el boot ni frena el registro contra el resto de
`IA_FLOW_REGISTER_SERVER_URLS`.

Notas de red: `IA_FLOW_REGISTER_SERVER_URLS` tiene que ser alcanzable DESDE
donde corre el agent-host (típicamente `localhost:<puerto-del-server>` si están
en la misma máquina). Esto NO funciona si el server vive dentro de un
container que no publica su puerto de API al host (ver
`apps/server/RUNNER-DEPLOY.md` — el `:3001` de esas instancias es privado a
propósito) — en ese caso, o publicá ese puerto en un puerto de host libre
(un `ports: 127.0.0.1:3011:3001` en el compose del runner), o seguí
registrando a mano desde adentro del container (sección de abajo).

Ejemplo concreto de este setup (agent-host en el host, server target en un
container): `IA_FLOW_REGISTER_SERVER_URLS=http://localhost:3011` (host →
container, vía el puerto publicado) e
`IA_FLOW_AGENT_HOST_PUBLIC_URL=http://host.containers.internal:3002` (container
→ host, vía la resolución de Podman).

### A mano (curl)

```bash
curl -X POST http://<server-principal>/api/provider-registrations \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "mi-maquina",
    "baseUrl": "http://<url-del-agent-host-o-túnel>",
    "token": "algo-random"
  }'
```

Para un server que corre en un container sin el puerto de API publicado
(ej. una instancia del flavor `runner`), corré el mismo `curl` desde
ADENTRO del container: `podman exec <container> curl ...` con `baseUrl`
apuntando a `http://host.containers.internal:<puerto-del-agent-host>`.

Contra un server con `api: full`, agregale la credencial:
`-H "x-ia-flow-token: <IA_FLOW_API_TOKEN de ese server>"`. Sin ella la
respuesta es un `401` — y el self-registro lo reporta con esas palabras en
vez de decir "ahí no hay un server", que es lo que diría un 401 sin token
configurado (el caso de haber puesto la URL del agent-host en vez de la del
server).

En ambos casos, el server valida contra `GET /v1/provider` de tu agent-host
(`fetchAgentHostProvider`) y, si responde, guarda la registración e instancia
un `RemoteAgentProvider` que a partir de ahí delega cada `run` a tu máquina
vía `POST /v1/run` — el server nunca sabe cómo se ejecuta.

Si el server principal no está en la misma red que tu agent-host, exponelo con
un túnel corrido a mano (`cloudflared tunnel --url http://localhost:3002`,
ngrok, etc.) y usá esa URL como `baseUrl`/`IA_FLOW_AGENT_HOST_PUBLIC_URL`.
