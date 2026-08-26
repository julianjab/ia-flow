# Pipeline de 4 agentes contra la-haus/subscriptions

Instancia de la imagen [`containers/runner`](../../containers/runner/README.md) (ver
ahí el mecanismo genérico: cómo se levanta, modo webhook/polling, auth,
logs, cambiar config sin rebuild). Esta carpeta solo tiene la config
puntual de este deploy: un roster de **4 agentes** formando un pipeline
completo contra un solo repo, `github.com/la-haus/subscriptions`.

```
agent:refine → subscriptions-refiner     → escribe un PRD técnico en el issue
agent:build  → subscriptions-implementer → escribe el código, abre un PR
agent:review → subscriptions-ci-watcher  → mira el CI del PR, no mergea nunca
agent:e2e    → lh116-e2e-tester-*        → valida el efecto runtime del cambio (solo assignee julianjab)
```

Los primeros 3 agentes son `mcpCatalogIds: [github-mcp]` — sin checkout
local (sin `fs_read`/`fs_write`/`bash_run`): todo el trabajo (leer código,
escribir archivos, abrir PR, mirar CI) sale por el **MCP oficial de GitHub**.
El paso `agent:e2e` (`lh116-e2e-tester-julianbuitrago-mac`) es la excepción:
corre vía `remote:julianbuitrago-mac` (ver más abajo) y su prompt asume bash
real (Docker, `lhtb`) — hoy ese provider (`ai-provider-gateway` con
`GATEWAY_PROVIDER=anthropic-api`) NO wirea bash/filesystem, así que esos
pasos del prompt no van a poder ejecutarse hasta que el gateway exponga
tools reales. Solo aplica cuando el issue está asignado a `julianjab`; para
cualquier otro assignee, el pipeline termina en `agent:review`+`ci-checked`
esperando merge humano, igual que antes.

## El pipeline en detalle

Este roster **no** usa `statusName`/`StatusLabelCodec` (el mecanismo estándar
de status vía un solo label `status:*` a la vez) — cada agente se gatea con
`when` sobre una label `agent:<nombre>` propia. Nada impide que convivan
varias `agent:*` labels a la vez si alguien las pone a mano; la disciplina de
"una sola por paso" la mantienen los `onProcess`/`onFinish`/`onError` de cada
agente en `agents.subscriptions.yaml`, no el source.

Los tres slots escriben con el mismo DSL que cualquier otro campo:
`$set:<campo>=<valor>`. `Labels` es el campo **multi-valor** del source, así
que su valor son operaciones con signo (`+añadir`, `-quitar`, `=` para
reemplazar el set completo) que el source resuelve contra las labels vigentes
— nunca pisa las que el agente no nombra.

| Paso | Label que dispara | Agente | Al empezar (`onProcess`) | Al terminar |
| --- | --- | --- | --- | --- |
| Refinar | `agent:refine` | `subscriptions-refiner` | saca `agent:refine` | `+agent:build` (éxito) / `+blocked` (error) |
| Implementar | `agent:build` | `subscriptions-implementer` | saca `agent:build`, `-ci-checked` | `+agent:review` (éxito, PR abierto) / `+blocked` (error) |
| Revisar CI | `agent:review` + `labels != ci-checked` | `subscriptions-ci-watcher` | saca `agent:review` | `+agent:e2e,+ci-checked` (CI verde) / `+agent:build` (CI rojo) |
| E2E (solo assignee `julianjab`) | `agent:e2e` + `labels != e2e-checked` | `lh116-e2e-tester-julianbuitrago-mac` | saca `agent:e2e` | `+e2e-checked` (éxito) / `-ci-checked,+agent:build` (falla) |

Cada agente saca su propia label disparadora apenas empieza — así, mientras
corre, el issue queda visible en GitHub como "se lo llevaron, todavía no
volvió" y el daemon no lo re-toma en el próximo scan (esto es además de que
el flag `working` de la task ya bloquea el re-dispatch del mismo run).

**Ni `subscriptions-ci-watcher` ni `lh116-e2e-tester-julianbuitrago-mac`
mergean el PR nunca** — cuando el CI está verde, `ci-watcher` pone
`agent:e2e` + `ci-checked` (en vez de volver a poner `agent:review` como
antes de agregar el paso e2e) para pasar al siguiente paso; si el e2e
también pasa, queda `e2e-checked` esperando merge humano. Si el CI da rojo,
`ci-watcher` pone `agent:build`; si el e2e falla, `lh116-e2e-tester-*` hace
lo mismo (y además saca `ci-checked`, para forzar un nuevo ciclo de CI
cuando el implementer re-pushee) — en ambos casos el `onProcess` de
`subscriptions-implementer` limpia `ci-checked` al empezar el nuevo ciclo.

### Branch: la crea el engine, no el implementer

`subscriptions-implementer` tiene `requiresBranch: true` — el engine crea la
[linked branch de GitHub](../../packages/agent-engine/src/linked-branch.ts)
**antes** de correr el agente y la deja en `{{task.branch}}`. El prompt
pushea ahí directamente (no crea una branch nueva por su cuenta), así
`subscriptions-ci-watcher` puede encontrar el PR de forma determinística
buscando por head branch = `{{task.branch}}`.

## Setup en GitHub antes de correr esto contra el repo real

En `github.com/la-haus/subscriptions`, creá estas labels:

- `ia-flow` — la label **ancla** (`anchorLabel` en `projects.yaml`): decide
  qué issues entran al pipeline de ia-flow en general. Ponela en cada issue
  que querés que el engine tome.
- `agent:refine`, `agent:build`, `agent:review`, `agent:e2e` — los 4 pasos
  del pipeline.
- `blocked` — cualquier agente falla (`fail_task`) y pone esta label; un
  humano revisa y se la saca a mano cuando está listo para reintentar (no
  hay agente automático que reaccione a `blocked`).
- `ci-checked` — la usa `subscriptions-ci-watcher` para marcar "ya revisé
  este PR y el CI está verde, no hace falta re-revisar".
- `e2e-checked` — la usa `lh116-e2e-tester-julianbuitrago-mac` para marcar
  "ya validé el efecto runtime y se comportó como el PRD esperaba" (solo
  aplica a issues asignados a `julianjab`; para el resto, el pipeline
  termina en `ci-checked`).

Un issue nuevo entra al pipeline con `ia-flow` + `agent:refine` puestos a
mano (o vía automatización externa).

## Auth — CLAUDE_CODE_OAUTH_TOKEN + GITHUB_TOKEN

`buildAnthropicAuthHeader` (`packages/ai-providers/src/anthropic-api/auth.ts`)
prioriza `CLAUDE_CODE_OAUTH_TOKEN` sobre `ANTHROPIC_API_KEY` cuando ambos
están seteados — este deploy usa el token OAuth, generalo con
`claude setup-token`.

`GITHUB_TOKEN` (Personal Access Token, classic o fine-grained) necesita
permisos de escritura sobre `la-haus/subscriptions`: `contents`
(crear branch + comitear), `pull_requests` (abrir PR + leer checks/CI), e
`issues` (leer/mover status vía label + comentar). Lo usan los 3 agentes
(vía el MCP de GitHub) y el source `github-issues` (leer/mover el issue) —
mismo token para todo.

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
`lh116-e2e-tester-julianbuitrago-mac` (`provider: remote:julianbuitrago-mac`
en `agents.subscriptions.yaml`), que corre solo cuando el issue está
asignado a `julianjab`.

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

- Ningún agente puede correr tests/lint localmente (sin `bash_run`) — la
  validación real la hace el CI del repo, y por eso existe el paso
  `subscriptions-ci-watcher`. El implementer debe ser conservador y preferir
  cambios chicos y verificables por lectura antes que cambios grandes que no
  puede probar él mismo.
- Un source `github-issues` está atado a un solo repo — si una tarea real
  cruza `subscriptions` con otro repo de La Haus, este roster no tiene forma
  de desglosarla; el refiner lo señala en "Riesgos y preguntas abiertas" pero
  no la parte solo.
