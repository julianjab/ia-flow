# Variables de prompt

Hay dos momentos de plantilla (`packages/agent-engine/definitions/CLAUDE.md`):

- **`{{vars.x}}` — al cargar.** Constantes de la fuente, sustituidas en el YAML crudo antes de
  validar (sirven también dentro de un `when`). Una var inexistente **rompe la carga**.
- **`{{path}}` — al correr.** Se resuelve contra la raíz del payload del evento más `steps`,
  `variables` e `input` (`packages/agent-engine/core/src/agent/PromptRenderer.ts`). Un path que no
  resuelve **queda literal** en el prompt, sin error: es el bug silencioso típico. Sólo
  `[\w.]` — sin filtros, sin índices.

## Qué hay en el payload de una task

Lo arma el intake: `apps/runner-v2/src/intake/payload.ts` (`assemblePayload`) sobre lo que
`intake/task.ts` (`taskPayload`) leyó de GitHub; el texto de `task.comments` y `task.ci` sale de
`taskTimeline` / `rollupCi` de `@ia-flow/github-tools` (`packages/github/tools/src/task/`).

| Path | Qué |
| --- | --- |
| `task.id` | `owner/repo#n` |
| `task.title`, `task.description`, `task.issueUrl` | el issue (description = body actual) |
| `task.repos`, `task.repo.name` | el repo de la task |
| `task.branch` | la rama de la task (`branchPrefix` del proyecto) |
| `task.comments` | la conversación del issue y del PR (comentarios, reviews, threads), en texto |
| `task.ci` | el estado agregado del CI del PR abierto (vacío sin PR) |
| `task.pr.*` | el PR abierto de la task, si hay (`number`, `url`, …) |
| `task.blockers` | los bloqueadores abiertos, uno por línea |
| `item.status`, `item.type`, `item.labels`, `item.repos`, `item.blocked` | la card: lo que filtran los `when` |
| `task_type`, `repo`, `owner`, `number`, `eventType` | atajos en la raíz |
| `project.repos` | el catálogo de repos del proyecto, en texto |
| `message` | el texto con el que el evento le llega a un agente que ya corre (inyección) |
| `event.payload.*` | el mismo payload, anidado (así lo leen los `brief`: `{{event.payload.from}}`) |

Más los campos propios de cada evento en la raíz — `from`/`to`, `body`/`author`, `pr.*`,
`state`/`reviewer`, `conclusion`… — listados en `pipelines.md` § "Qué eventos hay". Un campo
propio de un evento **no existe** cuando el agente corre por otro: un prompt compartido entre
pipelines no puede depender de `{{body}}`; eso va en el `brief` del paso de la pipeline que lo
trae.

## Fuera del payload

| Path | Qué |
| --- | --- |
| `input.*` | lo que otro agente le pasó por una ruta (`input` del agente) |
| `steps.<id>.*` | output de pasos anteriores de la pipeline; `steps.interruption.*` en un `onInterrupt`; el evento que despertó una pausa en `steps.<pausa>` |
| `variables.*` | `variables` del agente |

## Cómo verificar una variable

1. Buscá la clave en `payload.ts` / `task.ts` (o en `locate.ts` si es propia del evento).
2. Si dudás de la forma real, mirá un evento guardado: `GET /api/tasks/:owner/:repo/:n` (con
   `--serve`) o `payload_json` de la tabla `event_log` en `$IA_FLOW_HOME/runner.sqlite`
   (`sqlite3 -readonly`).
