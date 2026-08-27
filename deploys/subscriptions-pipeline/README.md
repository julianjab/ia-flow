# Pipeline de 4 agentes contra los repos de la-haus

Instancia de la imagen [`containers/runner`](../../containers/runner/README.md) (ver
ahí el mecanismo genérico: cómo se levanta, modo webhook/polling, auth,
logs, cambiar config sin rebuild). Esta carpeta solo tiene la config
puntual de este deploy: un roster de **4 agentes** formando un pipeline
completo contra los repos de la-haus declarados en
`projects/subscriptions-ai-flow/repos/` — backends (subscriptions,
ai-cognitive-platform, ims-backend), frontend (lh-seller-v2-frontend),
mobile (ai-mobile-app), infra (eks, platform-infrastructure) y repos de
agentes AI (ai-cx-agents, claw-agents, crm-claude-agents). La lista viva la
renderiza `{{project.repos}}` desde esa carpeta.

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
Build   → subscriptions-implementer → escribe el código, pushea la branch     → Review
Review  → reviewer                  → valida el diff (bugs, reglas del repo,
                                      seguridad, criterios del PRD, desfase),
                                      re-corre lint+tests, abre/actualiza el
                                      PR — nunca lo mergea                    → +reviewed
```

Una tarea sin `Task Type` fluye como técnica (`subscriptions-refiner` gatea
por `task_type != functional`, no por `= technical`) — es lo que hace que
las cards viejas y los sub-issues recién desglosados no necesiten el campo.
Los dos refiners además se reclasifican mutuamente: el técnico tiene la
salida `to-functional` (detectó una épica multi-repo → `Task Type=Functional`,
la card se queda en `Refine`) y el funcional la salida `to-technical` (la
"épica" cabía en un repo → `Task Type=Technical`). Cambiar el tipo los saca
de su propio criterio, así que no hay loop.

Los 4 agentes son `mcpCatalogIds: [github-mcp]`. Los dos refiners trabajan
sin checkout local (sin `fs_read`/`fs_write`/`bash_run`): todo su trabajo
(leer código, escribir issues) sale por el **MCP oficial de GitHub**. El
implementer y el reviewer suman fs_* / bash_run y trabajan con **repo
local** (worktree por task): el implementer valida y pushea; el reviewer
re-valida el diff completo y es quien abre y mantiene el PR. La división de
responsabilidades es deliberada — el implementer entrega **branch**, el
reviewer entrega **PR**: así ningún PR llega a un humano sin pasar por el
gate de calidad.

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
| Implementar | `Status = Build`, `Task Type ≠ Functional`, sin `blocked` | `subscriptions-implementer` | `-reviewed` (+ limpieza legacy) | `Review` (éxito, branch pusheada) / `+blocked`, queda en `Build` (error) / `Build` sin label (`repo-broken`: la base ya estaba rota — crea el issue del arreglo y se bloquea por él) |
| Revisar | `Status = Review`, `Task Type ≠ Functional`, sin `reviewed` ni `blocked` | `reviewer` | — | `+reviewed`, queda en `Review` (aprobado — abre/actualiza el PR, espera merge humano) / `Build` (`back-to-build`: recuperable con un ajuste o rebuild) / `+blocked`, queda en `Review` (error ajeno al cambio) |

Ningún agente saca ya su propia marca al arrancar: el disparador es el status,
y lo que evita el re-dispatch mientras corre es el `workingMarker`
(`Working = Yes`) declarado en `projects/subscriptions-ai-flow/project.yaml`,
más el flag `working` de la task.

### Las dos labels que sobreviven, y por qué

Ninguna de las dos nombra un paso — si lo hicieran, serían el status otra vez.

- **`reviewed`** — la marca de éxito del `reviewer`: su `when` la excluye
  (es lo que lo saca de su propio criterio al aprobar) y deja la card en
  `Review` como estado terminal "listo para merge humano".
  `subscriptions-implementer` la limpia al empezar el próximo ciclo (junto
  con `ci-checked`/`e2e-checked`, limpieza legacy de cards del roster
  anterior).
- **`blocked`** — la ponen los caminos de error que **no** mueven la card de
  columna, justamente para que quede a la vista donde falló. Todos los agentes
  la excluyen en su `when`, y no es opcional: sin eso el status seguiría
  matcheando y el próximo scan re-despacharía el mismo issue indefinidamente.
  Un humano la saca para reintentar.

### `repo-broken` — la base rota se bloquea sola, sin humano

Antes de implementar, el implementer valida el estado BASE del repo (lint +
tests sobre el worktree recién materializado). Si la base ya estaba rota por
causas ajenas a la tarea, arreglar el repo no es su alcance: crea un issue
nuevo con la evidencia (`create_github_issue` + `add_to_project`), marca la
tarea actual como bloqueada por él (`mark_blocked_by`) y sale por
`repo-broken`, que deja la card en `Build` **sin** label.

Lo que frena el re-dispatch ahí no es `blocked` sino el **gate de blockers**
del dispatcher (`allowBlocked: false` + `getBlockers` del source, que lee las
relaciones blocked-by vivas de GitHub): cuando el issue del arreglo se
cierra, la tarea se desbloquea y se re-despacha sola — a diferencia de
`blocked`, que necesita que un humano saque la label.

### El reviewer — un solo gate de calidad, con repo local

Reemplaza al par ci-watcher + e2e-tester del roster anterior. Corre SIEMPRE
en `anthropic-api` con el worktree de la task (lo sincroniza con `git fetch`
+ `git pull --ff-only` antes de mirar nada, porque el implementer pudo haber
pusheado desde otra máquina), y valida cinco dimensiones: bugs, criterios
técnicos del repo (CLAUDE.md/rules), seguridad, criterios funcionales y
técnicos del PRD (re-verificados contra el código, no confiando en los
tildes del implementer), y desfase del plan. Re-ejecuta lint y tests
localmente, y mira los checks de CI del PR si ya existen de un ciclo
anterior.

**El PR es suyo**: lo abre si no existe y le mantiene título y body en cada
pasada — el implementer entrega branch. Y nunca lo mergea: aprobar es
`+reviewed` y esperar al humano.

### Branch: la crea el engine, no el implementer

`subscriptions-implementer` tiene `requiresBranch: true` — el engine crea la
[linked branch de GitHub](../../packages/agent-engine/src/linked-branch.ts)
**antes** de correr el agente y la deja en `{{task.branch}}`. El prompt
pushea ahí directamente (no crea una branch nueva por su cuenta), así el
`reviewer` encuentra el diff y el PR de forma determinística por
head branch = `{{task.branch}}`.

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

**En cada repo del roster** (`projects/subscriptions-ai-flow/repos/` — no
solo `subscriptions`: los sub-issues de una épica viven en su repo destino),
creá estas labels:

- `blocked` — cualquier agente falla (`fail_task`) y pone esta label sin mover
  la card de columna; un humano revisa y se la saca a mano cuando está listo
  para reintentar (no hay agente automático que reaccione a `blocked`).
  Mientras esté puesta, ningún agente del roster toma el issue.
- `reviewed` — la usa el `reviewer` para marcar "diff validado y PR abierto,
  listo para merge humano".

Un issue nuevo entra al pipeline agregándolo al board y poniendo su `Status` en
`Refine` (a mano, o vía una automatización del propio board).

## Auth — CLAUDE_CODE_OAUTH_TOKEN + GITHUB_TOKEN

`buildAnthropicAuthHeader` (`packages/ai-providers/src/anthropic-api/auth.ts`)
prioriza `CLAUDE_CODE_OAUTH_TOKEN` sobre `ANTHROPIC_API_KEY` cuando ambos
están seteados — este deploy usa el token OAuth, generalo con
`claude setup-token`.

`GITHUB_TOKEN` (Personal Access Token, classic o fine-grained) necesita
permisos de escritura sobre TODOS los repos del roster
(`projects/subscriptions-ai-flow/repos/`): `contents` (crear branch +
comitear), `pull_requests` (abrir PR + leer checks/CI), e `issues`
(leer/comentar/crear — el functional-refiner crea sub-issues y el
implementer issues de base rota). Además necesita `project` (leer y
escribir la columna `Status` y el campo `Working` del board 119). Lo usan
todos los agentes (vía el MCP de GitHub y las tools del engine) y el source
`github-project` (leer los items y mover el `Status`) — mismo token para
todo.

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
self-registra contra este container como `julianbuitrago-mac`. Lo usa el
`subscriptions-implementer` vía `provider: remote:*` (cualquier gateway
registrado que acepte la tarea según sus admissionRules); sin ningún gateway
vivo, el implementer cae a `anthropic-api` dentro del container.

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

- La validación local (lint/tests vía `bash_run`) del implementer y del
  reviewer depende de que la máquina donde corre el run tenga el toolchain
  del repo instalado. El contenedor del runner hoy NO trae
  uv/flutter/bundler/yarn: un implementer que cayó al fallback
  `anthropic-api`, y el reviewer siempre (corre ahí), pueden quedarse sin
  poder correr los tests — el prompt de ambos exige registrar explícitamente
  qué quedó sin verificar, y el reviewer decide con las dimensiones
  estáticas (diff vs PRD, reglas del repo, seguridad). Para validación
  completa, instalá los toolchains en la imagen del runner.
- Los sub-issues que crea el `functional-refiner` entran al board **sin
  Status** (`add_to_project` no setea campos del board): un humano tiene que
  triagearlos a `Refine` para que el pipeline los tome. Es deliberado (gate
  de aprobación del desglose), pero significa que un desglose olvidado en
  "No Status" no avanza solo.
- El roster de repos que el `functional-refiner` puede usar sale de
  `{{project.repos}}`, que renderiza `- <name> — <description>` desde
  `projects/subscriptions-ai-flow/repos/` en cada dispatch: agregar un repo
  al pipeline es UNA entrada ahí, y su `description` es lo que el
  descomponedor lee para decidir dónde aterriza cada sub-issue — escribila
  con qué es, stack y cómo se valida.
