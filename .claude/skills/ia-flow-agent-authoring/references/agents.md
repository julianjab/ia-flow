# Agentes — campos, actions y salidas

Schema: `AgentDoc` en `packages/agent-engine/definitions/src/schema.ts` (strict: una clave que no
existe rompe la carga). Ejemplo completo y comentado:
`projects/lahaus-ai-flow/agents/20-implementer.yaml` de la config de La Haus (`la-haus/claw-agents` → `agents/ai-development-flow/config/`).

Un archivo por agente, `id` adentro. Un agente global (en `agents/` junto a `runner.yaml`) lo ve
la fuente global; los de un proyecto, su proyecto.

## Prompt

| Campo | Qué |
| --- | --- |
| `systemPrompts` | `[{ text }]` o `[{ id }]`. Van DESPUÉS de los de la fuente (`project.yaml`), que son el prefijo compartido y cacheable. El método del agente va acá |
| `prompt` | Lo que cambia por corrida: lo que lleva `{{...}}` (ver `variables.md`) |
| `variables` | Constantes del agente: `{{variables.<k>}}` |
| `input` | Lo que recibe cuando lo alcanza una ruta de otro agente: `{{input.<k>}}` |

El `brief` del paso de la pipeline se antepone al `prompt`: ahí va el "por qué corrés ahora".

## Actions

`actions` es la lista cerrada de lo que el agente puede usar como tool (además de las de cierre).
Entrada: `<id>` o `{ action, allowWrite?, with?, options? }`.

- **Catálogo:** `apps/runner-v2/src/actions/builtin/` (`github.ts`, `workspace.ts`, `slack.ts`,
  `project.ts`, …; el índice en `index.ts`) — registra las de `@ia-flow/github-tools`
  (`packages/github/tools/src/actions/`), `@ia-flow/slack-tools` y `@ia-flow/workspace` (`fs_*`,
  `bash_run`, `run_agent`). Las del proyecto:
  `projects/<id>/actions/*.ts` (ej. `issue_body`, `blocked_report`). Confirmá el id antes de usarlo:
  uno inexistente rompe la carga.
- **Escritura:** una action que escribe necesita `allowWrite: true` en su entrada, o
  `allowWrites: true` en el agente (listarla ya es la decisión).
- **`with`** fija campos del input: el modelo no los ve ni los elige.
- **`options`** arma una action a pedido. `bash_run`: `allow`/`deny` (patrones posicionales por
  comando, sin shell), `githubAuth`, `timeout`, `maxTimeout`. `issue_body`: `write`/`check` (qué
  secciones del body puede reescribir o tildar).
- **Workspace:** `fs_*` y `bash_run` trabajan sobre el worktree de la task (`WORKSPACE_DIR`). Un
  provider CLI (`claude-cli`) tiene además sus tools nativas, que esta lista no controla.
- `mcpServers`: ids del catálogo `mcp` de `runner.yaml` (ver `providers-and-mcp.md`).

## Durante la corrida

| Campo | Qué |
| --- | --- |
| `onStart` | Pasos antes del modelo (sacar labels, `link_branch`). Si tira, el agente no arranca |
| `injects` | `[{ on, when }]`: eventos que se le inyectan mientras corre en vez de esperar. Son TODO el filtro: excluí también lo que publica el engine (`<!-- ia-flow:`) |
| `waits` | `{ on, defaultMinutes?, maxMinutes? }`: habilita `wait_for_event` (pausa a mitad del turno y sigue en la misma conversación) |
| `maxConcurrent` | Tope de corridas de este agente entre todas las tasks |
| `when` / `whenText` | Filtro del agente donde sea que corra (el del paso gana) |

## Salidas (`routes`)

El turno termina con UNA de estas tools:

- `submit_<salida>` por cada entrada de `routes` (sin `routes`: `submit_done`). Su input es el
  texto del `report` más el input de los destinos que lo aceptan.
- `fail_turn` → la cascada `onError`.
- `yield_turn` (sólo si lo interrumpieron) → la cascada `onInterrupt`.
- `wait_for_event` (sólo con `waits`) → pausa; al volver sigue el mismo turno.

```yaml
routes:
  done:
    when: >-            # texto para el modelo: cuándo elegirla
      Implementaste, validaste y pusheaste.
    to:                 # acciones, una pausa o `end` — encadenar AGENTES va en la pipeline
      - { action: ensure_pull_request }
      - pause: wait-ci
        branches:
          green: { on: [check_suite, workflow_run], when: [...], to: { action: update_issue, with: { status: Review } } }
        timeout: { after: 30m, to: { action: update_issue, with: { status: Review } } }
  repo_broken:
    when: El repo base ya estaba roto y creaste el issue del arreglo.
    to: { action: update_issue, with: { status: Build } }
```

Reglas (detalle en `packages/agent-engine/core/CLAUDE.md` § "Salidas de un agente"):

- **Cascada paso > pipeline > agente > proyecto.** El agente declara las salidas; la pipeline
  sólo cambia destinos o las elimina. Una salida sin `to` es vocabulario: la pipeline tiene que
  darle destino o no carga.
- **`report` corre antes que los destinos** (el comentario queda antes de mover la card).
  Defínelo en el agente (`report: { action: post_comment, with: { target: pr-else-issue } }`) o
  `report: null` para no comentar.
- **Una `pause` va última** en su lista de destinos y nunca en un `onError`. Siempre con
  `timeout`: sin él, una pausa que no despierta espera para siempre.
- **`onError`** (`{ to, input?, report? }`, mappers por nombre) y **`onInterrupt`** (`{ to }`,
  sus pasos leen `{{steps.interruption.reason}}`, y también `.progress`, `.by`, `.agent`) vienen de `project.yaml` si
  el agente o la pipeline no los pisan.
- Cada salida tiene que dejar la task fuera del `when` que la disparó (ver `pipelines.md` § Loops).
