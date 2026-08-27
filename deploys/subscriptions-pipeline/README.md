# Pipeline de 5 agentes contra los repos de la-haus

Instancia de la imagen [`containers/runner`](../../containers/runner/README.md) (ver
ahí el mecanismo genérico: cómo se levanta, modo webhook/polling, auth,
logs, cambiar config sin rebuild). Esta carpeta solo tiene la config
puntual de este deploy: un roster de **5 agentes** formando un pipeline
completo contra los repos de la-haus declarados en
`projects/subscriptions-ai-flow/repos/` (subscriptions, conversations,
ai-cognitive-platform, ims-backend, lh-checkout-api, lh-seller-v2-frontend,
ai-mobile-app).

El paso lo marca la **columna `Status`** del board
[la-haus/projects/119](https://github.com/orgs/la-haus/projects/119), y el
TIPO de tarea el campo single-select **`Task Type`** (`Functional` /
`Technical`) del mismo board — es lo que reparte la columna `Refine` entre
los dos refiners:

```
Refine (Task Type=Functional)
        → functional-refiner        → PRD funcional en la épica + un sub-issue
                                      técnico por repo (nacen SIN status: un
                                      humano los triagea a Refine — el gate de
                                      aprobación del desglose)               → Refined
Refine  → subscriptions-refiner     → escribe un PRD técnico en el issue      → Refined
Refined → (gate humano: mover la card a Build aprueba el PRD)
Build   → subscriptions-implementer → escribe el código, abre un PR           → Review
Review  → subscriptions-ci-watcher  → mira el CI del PR, no mergea nunca      → +ci-checked
Review  → e2e-tester-julianbuitrago-mac (con `ci-checked`, solo assignee julianjab)
          → valida el efecto runtime del cambio                              → +e2e-checked
```

Una tarea sin `Task Type` fluye como técnica (`subscriptions-refiner` gatea
por `task_type != functional`, no por `= technical`) — es lo que hace que
las cards viejas y los sub-issues recién desglosados no necesiten el campo.
Los dos refiners además se reclasifican mutuamente: el técnico tiene la
salida `to-functional` (detectó una épica multi-repo → `Task Type=Functional`,
la card se queda en `Refine`) y el funcional la salida `to-technical` (la
"épica" cabía en un repo → `Task Type=Technical`). Cambiar el tipo los saca
de su propio criterio, así que no hay loop.

Los primeros 4 agentes son `mcpCatalogIds: [github-mcp]` — el
functional-refiner, el refiner y el ci-watcher sin checkout local (sin
`fs_read`/`fs_write`/`bash_run`): todo su trabajo (leer código, escribir
issues, abrir PR, mirar CI) sale por el **MCP oficial de GitHub**; el
implementer suma fs_* y bash_run para validar con el lint/test del repo.
El paso e2e (`e2e-tester-julianbuitrago-mac`) es la excepción:
corre vía `remote:julianbuitrago-mac` (ver más abajo) y su prompt asume bash
real (Docker, `lhtb`) — hoy ese provider (`ai-provider-gateway` con
`GATEWAY_PROVIDER=anthropic-api`) NO wirea bash/filesystem, así que esos
pasos del prompt no van a poder ejecutarse hasta que el gateway exponga
tools reales. Solo aplica cuando el issue está asignado a `julianjab`; para
cualquier otro assignee, el pipeline termina en `Review` + `ci-checked`
esperando merge humano, igual que antes.

## El pipeline en detalle

Cada agente se gatea con `statusName` — el **tercer filtro** de `selectAgent`,
contra la columna `Status` del board. Antes el gate era una label `agent:*`
por paso: una réplica a mano del concepto de status, heredada de cuando este
roster corría contra un source `github-issues`, que no tenía statuses. El
board sí los tiene, y mantener las dos cosas dejaba dos fuentes de verdad para
"dónde está esta tarea".

Los outcomes escriben con el mismo DSL que cualquier otro campo:
`$set:<campo>=<valor>`, y un outcome que es sólo un nombre de status
(`success: Review`) es la forma corta de `$set:Status=Review`. `Labels` es el
campo **multi-valor** del source, así que su valor son operaciones con signo
(`+añadir`, `-quitar`, `=` para reemplazar el set completo) que el source
resuelve contra las labels vigentes — nunca pisa las que el agente no nombra.

| Paso | Gate | Agente | Al empezar (`onProcess`) | Al terminar |
| --- | --- | --- | --- | --- |
| Desglosar épica | `Status = Refine`, `Task Type = Functional`, sin `blocked` | `functional-refiner` | — | `Refined` + sub-issues técnicos creados por repo, sin status (éxito) / `+blocked`, queda en `Refine` (error) / `Task Type=Technical`, queda en `Refine` (`to-technical`) |
| Refinar | `Status = Refine`, `Task Type ≠ Functional`, sin `blocked` | `subscriptions-refiner` | — | `Refined` (éxito) / `+blocked`, queda en `Refine` (error) / `Build` (`back-to-build`) / `Task Type=Functional`, queda en `Refine` (`to-functional`) |
| Aprobar desglose | — | **humano** | — | mueve cada sub-issue de "No Status" a `Refine` |
| Aprobar PRD | — | **humano** | — | mueve la card de `Refined` a `Build` |
| Implementar | `Status = Build`, `Task Type ≠ Functional`, sin `blocked` | `subscriptions-implementer` | `-ci-checked,-e2e-checked` | `Review` (éxito, PR abierto) / `+blocked`, queda en `Build` (error) |
| Revisar CI | `Status = Review`, sin `ci-checked` ni `blocked` | `subscriptions-ci-watcher` | — | `+ci-checked`, queda en `Review` (CI verde) / `Build` (CI rojo) / `Review` sin tocar labels (`ci-pending`) |
| E2E (solo assignee `julianjab`) | `Status = Review` **con** `ci-checked`, sin `e2e-checked` ni `blocked` | `e2e-tester-julianbuitrago-mac` | — | `+e2e-checked` (éxito) / `Build` + `-ci-checked` (falla) / `Refine` + `-ci-checked,-e2e-checked` (`back-to-refine`) |

Ningún agente saca ya su propia marca al arrancar: el disparador es el status,
y lo que evita el re-dispatch mientras corre es el `workingMarker`
(`Working = Yes`) declarado en `projects/subscriptions-ai-flow/project.yaml`,
más el flag `working` de la task.

### Las dos labels que sobreviven, y por qué

Ninguna de las dos nombra un paso — si lo hicieran, serían el status otra vez.

- **`ci-checked` / `e2e-checked`** — el board **no tiene una columna para el
  paso e2e**, así que `ci-watcher` y `e2e-tester` comparten `Review` y el orden
  dentro de esa columna lo marca `ci-checked`: el watcher corre mientras NO
  esté, el e2e-tester sólo cuando ya está. `subscriptions-implementer` las
  limpia al empezar el próximo ciclo. (La alternativa era agregar una opción
  `E2E` al Status del board 119 — se descartó para no tocar un board de la org
  desde este deploy.)
- **`blocked`** — la ponen los caminos de error que **no** mueven la card de
  columna, justamente para que quede a la vista donde falló. Todos los agentes
  la excluyen en su `when`, y no es opcional: sin eso el status seguiría
  matcheando y el próximo scan re-despacharía el mismo issue indefinidamente.
  Un humano la saca para reintentar.

### `ci-pending` — "todavía no hay veredicto" no es un fallo

`subscriptions-ci-watcher` se dispara **apenas el implementer abre el PR**, o
sea antes de que ningún check pueda haber concluido: un CI pendiente es el caso
normal, no el borde. Reusar `error` para eso devolvía la card a `Build`, el
`onProcess` del implementer borraba `ci-checked` y arrancaba un run Opus entero
sobre un PR que estaba perfectamente bien — un ciclo Build→Review→Build hasta
que el CI ganara la carrera.

Por eso hay una salida `ci-pending`, que el agente pide con `select_exit`: deja
la card en `Review` **sin** `ci-checked`, así el próximo evento (en modo
webhook, el `check_suite` que termina) vuelve a elegir este mismo agente y esa
vez sí hay veredicto. Re-escribe `Status=Review` sobre sí mismo porque `set` no
puede ser vacío — `exitSet` devolvería falsy y `resolveExit` caería al `error`
que justamente queremos evitar.

**Ni `subscriptions-ci-watcher` ni `e2e-tester-julianbuitrago-mac` mergean el
PR nunca** — cuando el CI está verde, `ci-watcher` deja la card en `Review` con
`ci-checked`, que es el pase al paso e2e; si el e2e también pasa, queda
`e2e-checked` esperando merge humano. Si el CI da rojo, `ci-watcher` devuelve
la card a `Build`; si el e2e falla, el e2e-tester hace lo mismo (y además saca
`ci-checked`, para forzar un nuevo ciclo de CI cuando el implementer
re-pushee).

### Branch: la crea el engine, no el implementer

`subscriptions-implementer` tiene `requiresBranch: true` — el engine crea la
[linked branch de GitHub](../../packages/agent-engine/src/linked-branch.ts)
**antes** de correr el agente y la deja en `{{task.branch}}`. El prompt
pushea ahí directamente (no crea una branch nueva por su cuenta), así
`subscriptions-ci-watcher` puede encontrar el PR de forma determinística
buscando por head branch = `{{task.branch}}`.

## Setup en GitHub antes de correr esto contra el repo real

**En el board [la-haus/projects/119](https://github.com/orgs/la-haus/projects/119)**,
la columna `Status` tiene que tener (al menos) estas opciones, con ese nombre
exacto — el match de `statusName` es case-insensitive pero literal:

`Refine` · `Refined` · `Build` · `Review`

Las demás opciones que ya existen (`Backlog`, `Todo`, `In Progress`, `Done`)
no tienen agente: una card ahí simplemente no la toma nadie.

También necesita el campo **`Working`** (`workingMarker` en
`projects/subscriptions-ai-flow/project.yaml`): es la marca anti-doble-dispatch
que sobrevive al proceso. Si el board no la tiene, el pipeline **no** se frena
— `getHealth` lo reporta como warning.

**En `github.com/la-haus/subscriptions`**, creá estas labels:

- `blocked` — cualquier agente falla (`fail_task`) y pone esta label sin mover
  la card de columna; un humano revisa y se la saca a mano cuando está listo
  para reintentar (no hay agente automático que reaccione a `blocked`).
  Mientras esté puesta, ningún agente del roster toma el issue.
- `ci-checked` — la usa `subscriptions-ci-watcher` para marcar "ya revisé este
  PR y el CI está verde", y es lo que habilita el paso e2e dentro de la misma
  columna `Review`.
- `e2e-checked` — la usa `e2e-tester-julianbuitrago-mac` para marcar "ya validé
  el efecto runtime y se comportó como el PRD esperaba" (solo aplica a issues
  asignados a `julianjab`; para el resto, el pipeline termina en `ci-checked`).

Un issue nuevo entra al pipeline agregándolo al board y poniendo su `Status` en
`Refine` (a mano, o vía una automatización del propio board).

## Auth — CLAUDE_CODE_OAUTH_TOKEN + GITHUB_TOKEN

`buildAnthropicAuthHeader` (`packages/ai-providers/src/anthropic-api/auth.ts`)
prioriza `CLAUDE_CODE_OAUTH_TOKEN` sobre `ANTHROPIC_API_KEY` cuando ambos
están seteados — este deploy usa el token OAuth, generalo con
`claude setup-token`.

`GITHUB_TOKEN` (Personal Access Token, classic o fine-grained) necesita
permisos de escritura sobre `la-haus/subscriptions`: `contents`
(crear branch + comitear), `pull_requests` (abrir PR + leer checks/CI), e
`issues` (leer/comentar). Además necesita `project` (leer y escribir la
columna `Status` y el campo `Working` del board 119). Lo usan los 3 primeros
agentes (vía el MCP de GitHub) y el source `github-project` (leer los items y
mover el `Status`) — mismo token para todo.

## Run

```bash
cd deploys/subscriptions-pipeline
cp subscriptions.env.example .env   # completar CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN
docker compose up -d --build        # o: podman compose up -d --build
docker compose logs -f subscriptions
```

Modo webhook (default) — mapea el proxy a `127.0.0.1:8788` (8788, no 8787:
si corrés esto junto a `deploys/implementer-accountant` en la misma
máquina, no chocan de puerto). Ver
[README de containers/runner](../../containers/runner/README.md) para el detalle
del túnel + secret del webhook, y cómo cambiar a modo `polling`.

El provider gateway ([apps/ai-provider-gateway](../../apps/ai-provider-gateway/README.md))
NO corre dentro de este compose — corre en tu HOST directo
(`cd apps/ai-provider-gateway && bun run dev`, puerto 3002 por default) y se
self-registra contra este container como `julianbuitrago-mac`. Lo usa
`e2e-tester-julianbuitrago-mac` (`provider: remote:julianbuitrago-mac` en
`projects/subscriptions-ai-flow/agents/40-e2e-tester.yaml`), que corre solo
cuando el issue está asignado a `julianjab`.

Conectividad host ↔ container (ver el comentario al principio de
`docker-compose.yml` para el detalle completo):
- Este compose publica la API de `subscriptions` en `127.0.0.1:3011` (no
  `3001`, que ya lo ocupa tu server principal en el host) — el gateway se
  registra contra `http://localhost:3011`.
- El gateway expone `IA_FLOW_GATEWAY_PUBLIC_URL=http://host.containers.internal:3002`
  para que `subscriptions` (dentro del container) pueda llegar de vuelta al
  gateway en tu host.

Configurá esto en `apps/ai-provider-gateway/.env` (ver su README) — no hay
nada que setear para esto en el `.env` de esta carpeta.

## Limitaciones conocidas

- El implementer sólo valida localmente (lint/tests vía `bash_run`) cuando el
  run aterriza en una máquina con el toolchain del repo instalado; en el
  fallback `anthropic-api` dentro del contenedor no hay uv/flutter/bundler/
  yarn, así que esos runs no validan y dependen del CI real — por eso existe
  el paso `subscriptions-ci-watcher`, y por eso el prompt le exige ser
  conservador cuando no pudo validar.
- Los sub-issues que crea el `functional-refiner` entran al board **sin
  Status** (`add_to_project` no setea campos del board): un humano tiene que
  triagearlos a `Refine` para que el pipeline los tome. Es deliberado (gate
  de aprobación del desglose), pero significa que un desglose olvidado en
  "No Status" no avanza solo.
- El roster de repos que el `functional-refiner` puede usar está duplicado a
  mano en su prompt (la tabla de "Repos disponibles") — agregar un repo al
  pipeline es una entrada en `projects/subscriptions-ai-flow/repos/` MÁS una
  fila en esa tabla; el agente no descubre `repos/` en runtime.
