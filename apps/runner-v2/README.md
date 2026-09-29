# runner-v2

El runner headless de ia-flow sobre [`@ia-tools/agent-engine`](https://github.com/julianjab/ia-tools):
lee `.config/`, registra las actions de cada scope, monta el engine y levanta el servidor de
webhooks. No traduce ni arma eventos: eso lo hacen las pipelines y las actions de `.config/`. Es el `ai-development-flow` de `ia-tools/examples` traído acá,
con la definición del pipeline como datos y las ejecuciones en SQLite.

## Qué cambia respecto del runner de `apps/server`

- **La definición vive en `.config/`**, en YAML (`@ia-tools/agent-engine-datasource-yaml` la traduce a
  definiciones y `@ia-tools/agent-engine-definitions` las arma)
  (agentes y pipelines del engine), y se recarga en caliente: editar un YAML aplica en el
  próximo evento, sin reiniciar. Una versión inválida se loguea y sigue la última buena.
- **Las ejecuciones persisten en SQLite** (`bun:sqlite`, `.state/executions.sqlite`): una task
  nunca corre dos agentes a la vez, y una pausa —esperar el CI después de abrir el PR— sobrevive
  a un reinicio. Una corrida que el reinicio cortó queda `failed` (`interrupted`) y lo que no
  llegó a leer se vuelve a despachar.

## `.config/`

`runner.yaml` es el índice: nada se descubre por carpeta, cada cosa se declara. Un archivo por
scope — lo global en `runner.yaml`, lo de un proyecto en su `project.yaml`.

```yaml
# runner.yaml
engine: { … }                       # CÓMO corre: store de ejecuciones, tick, whenText, formatMessage
sources:                            # QUÉ corre: la composición del runner
  pipelines: [ … ]                  # la fuente global: el intake, inline
  actions: ./actions                # actions globales
  projects:
    lahaus-ai-flow: ./projects/lahaus-ai-flow/project.yaml   # o el proyecto inline

# projects/lahaus-ai-flow/project.yaml
board: https://github.com/orgs/la-haus/projects/119
branchPrefix: ia-flow-local/
label: blocked
systemPrompts: [ … ]                # los defaults de su fuente (antes source.yaml)
onError: { … }
agents: ./agents
pipelines: ./pipelines
actions: ./actions
repos: ./repos
```

`agents`, `pipelines` y `repos` aceptan, solos o en lista, un directorio (sus `*.yaml` en orden de
nombre), un archivo, un glob en el nombre del archivo (`./pipelines/1*.yaml`) o el documento
inline; `actions` (código) sólo rutas — un directorio toma sus `*.ts` directos (no `_lib/`, ni
tests). Las rutas son relativas al archivo que las declara, y una que no existe rompe el arranque.
Editar `runner.yaml` o un `project.yaml` recarga sus fuentes (agentes y pipelines) sin reiniciar;
lo demás (board, label, actions, repos) se lee al arrancar.

El engine no sabe de proyectos: ve fuentes. El proyecto es una capa del runner que sólo filtra:
al montar un proyecto, el runner le pone `scope.projectId: <id>` a cada una de sus pipelines
(una propiedad más de la definición, `src/projects/withScope.ts`), así sólo corren con los eventos
de ese proyecto —los que publica `resolve_task`—; la global recibe todo. El engine lo arma el
runner desde `engine:` de runner.yaml (`src/engine/mountEngine.ts`).

### Las actions (`actions/`)

Cada `*.ts` que está directo en una carpeta `actions/` exporta por default una definición (o una
lista) y se registra sola en su scope:

```ts
import { defineAction } from '@ia-flow/runner-v2/actions'
export default defineAction({ id: 'resolve_task', create: (ctx) => new ResolveTaskAction(…) })
```

`create` recibe quién la pide (`sourceId`, `agentId`, las `options` del YAML), el proyecto de esa
fuente, todos los proyectos y los servicios que monta el runner (GitHub, workspace, la credencial de git). Una
fuente de proyecto ve primero las suyas y después las globales; la global, sólo las globales. Un
id repetido en el mismo scope rompe el arranque. `defineMapper` registra un mapper de `onError`.

Las actions importan paquetes y el contrato del runner: la carpeta de la definición tiene que
vivir DENTRO de `apps/runner-v2` (así resuelven sus dependencias), también con `RUNNER_CONFIG_DIR`.

### Las pipelines (`pipelines/`)

Una por momento del flujo, no por variante: `refine`, `build-arrival`, `build-reentry`, `review`,
`e2e`, `ci-red`, `pr-changes-requested` y `comment`. Qué agente atiende lo decide el `when` de
cada paso — por tipo de task y por repo (frontend o el resto) —, y `firstMatch: true` corre sólo
el primero que pasa, así que el orden de los pasos es la prioridad. En `comment`, si el comentario
pide un cambio lo decide su `whenText` (Haiku). Un mismo agente no puede ser dos pasos de una
pipeline: por eso llegada y reentrada a Build, o CI rojo y cambios pedidos, son pipelines aparte.

### El intake

Un webhook entra al engine tal cual lo mandó GitHub (`github.<evento>`) y lo recibe el intake:
El intake (`intake`, inline en `sources.pipelines` de runner.yaml) es un solo paso, `resolve_task` (`actions/resolve_task.ts`). Es uno
para todos los proyectos: decide de cuál es el evento (el board del item, el catálogo de repos, la
card del issue y la label) y, por cada uno, encuentra la task
(el issue detrás de un item del board, el que implementa el PR de un comentario o de un CI), la
lee de GitHub —card, issue, blockers, timeline del issue y del PR, CI— y publica el evento de la
task con su scope. No publica nada para un repo fuera del catálogo, ni para una card de otro
board o sin la `label` del proyecto (`project.yaml`; hoy `blocked`): esas son del engine de
producción. El evento lleva `message`, el texto con el que le llega a un agente que ya corre. `intake-unblock` es el mismo paso con `unblockDependents: true`.

Lo que el YAML nombra y definen las `actions/`:

| Nombre | Qué es |
| --- | --- |
| `update_issue`, `post_comment` | transiciones del board y el comentario de cierre (firmado por el agente) |
| `react_to_comment`, `review_pull_request`, `pr_checks`, `create_github_issue`, … | las tools de GitHub del proyecto |
| `fs_read`, `fs_list`, `fs_grep`, `fs_write`, `fs_edit`, `bash_run` | disco sobre el worktree de la task; `bash_run` con `options` (`allow`, `deny`, `githubAuth`, `timeout`, `maxTimeout`) |
| `issue_body` | las tools del body del issue que el agente puede tocar (`options: { write, check }`) |
| `blockedReport` | el reporte de una corrida que falló (el `onError` del proyecto) |
| `resolve_task` | el intake: de un webhook crudo al evento de su task (`unblockDependents` para el unblock) |

## Correr

Los paquetes de ia-tools todavía no se publican: se consumen con `bun link` desde un clon de
ia-tools al lado de ia-flow (`IA_TOOLS_DIR` si está en otro lado), instalado y compilado.

```bash
# una vez por máquina (y cuando se agregue un paquete)
(cd ../ia-tools && pnpm install && pnpm build)
bun run --cwd apps/runner-v2 link:ia-tools
bun install

cd apps/runner-v2
bun run start                                     # verifica GitHub, carga y valida la definición
bun run src/main.ts --event github.issue_comment ./delivery.json   # un webhook crudo, por el intake
bun run src/main.ts --replay-pr la-haus/subscriptions#45           # un PR real, como `opened`
IA_FLOW_WEBHOOK_SECRET=... bun run serve         # servidor de webhooks
bun test
bun run typecheck
```

Bun carga el `.env` del directorio desde el que corre (gitignoreado). Variables:

| Variable | Para qué |
| --- | --- |
| `IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH` | el PEM de la GitHub App (el resto de la App está en `runner.yaml`) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | el provider `anthropic-api` |
| `IA_FLOW_WEBHOOK_SECRET` | el HMAC de los webhooks (sin él, todo POST responde 503) |
| `FIGMA_MCP_TOKEN` | el token del MCP de Figma (`runner.yaml` lo nombra como `${FIGMA_MCP_TOKEN}`) |
| `RUNNER_CONFIG_DIR` | otra carpeta de definición (default: `.config`) |
| `WORKSPACE_DIR` | dónde van clones y worktrees (default: `~/.cache/ia-flow/runner-v2/workspaces`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | trazas y logs por OTLP |

## Tareas bloqueadas por otras (`mark_blocked_by`)

Una card con prerrequisitos abiertos no corre sus agentes (las pipelines filtran
`item.blocked`, salvo las de agentes que admiten correr bloqueados, como los refiners técnicos).
Cuando se mergea el PR del último prerrequisito, el intake (`intake-unblock`) busca en
GitHub los issues que ése bloqueaba (`dependencies/blocking`) y emite `issue.unblocked` para cada
uno que quedó sin bloqueadores abiertos. Las pipelines de
reentrada de cada columna lo escuchan, así que la card vuelve al agente que le toca donde esté.
Es el `unblock-dependents-on-merge` del runner de ia-flow, pero para PRs de cualquier repo del
catálogo, no sólo de `claw-agents`.

## Lo que no se portó del ejemplo

- Las tools `memory_*` del implementer: el runner no las tiene (tampoco el ejemplo).
- Los `settings` del runner de `apps/server` que este runner no implementa (API, websocket,
  polling, remote providers): `runner.yaml` sólo acepta lo que se usa.
