# Recetas y anti-patrones

## Receta 1 — Pipeline por labels (source `github-issues`)

Cada paso se activa por una label `agent:<paso>`; el agente se la quita al arrancar y pone
la del siguiente al terminar. Es el patrón del deploy `agents/subscriptions-pipeline/`.

```
agent:refine → refiner      → agent:build   (ok) / blocked (error)
agent:build  → implementer  → agent:review  (ok) / blocked (error)
agent:review → ci-watcher   → agent:review + ci-checked (verde) / agent:build (rojo)
```

```yaml
- id: mi-implementer
  provider: anthropic-api
  when:
    - field: labels
      op: '='
      value: 'agent:build'
  allowBlocked: false
  requiresBranch: true                       # escribe vía MCP, sin write tools locales
  mcpCatalogIds: [github-mcp]
  onProcess: '$set:Labels=-agent:build,-ci-checked'
  onFinish: '$set:Labels=+agent:review'
  onError: '$set:Labels=+blocked'
```

Puntos clave:

- El `onProcess` que quita la label disparadora (`$set:Labels=-agent:build`) es lo que
  evita que el daemon lo vuelva a tomar mientras corre.
- `Labels` es un campo multi-valor: los tokens con signo operan sobre las labels actuales,
  no las reemplazan. Para reemplazar el set completo hace falta `=` explícito.
- Para que un paso **espere** (ej. merge humano) sin re-dispararse: re-pone su propia label
  y agrega una marca (`ci-checked`), y su `when` excluye esa marca con `op: '!='`.
- Nada impide que convivan varias `agent:*` si alguien las pone a mano — la disciplina la
  mantienen los outcomes, no el source. No mezcles este esquema con `status:*` en un repo.

## Receta 2 — Pipeline por status (source `github` / Project v2)

```yaml
- id: refinador
  statusName: 'Backlog'
  onProcess: '$set:status=Refining'
  onFinish: 'Ready'
  onError: '$set:status=Blocked'
```

Más simple porque el source garantiza un solo status a la vez. Úsalo cuando el proyecto ya
tiene columnas que representan el pipeline.

## Receta 3 — Agente MCP-only (sin checkout local)

Cuando el repo no está clonado en el host o no querés sandbox local:

```yaml
tools: [update_issue_body]      # sólo tools de task
mcpCatalogIds: [github-mcp]
requiresBranch: true            # imprescindible si va a pushear a {{task.branch}}
```

El prompt describe el flujo con las tools que sí tiene: navegá el repo con las tools del
MCP de GitHub (`get_file_contents` para leer/listar, `search_code` para buscar patrones) y
leé `CLAUDE.md` / `AGENTS.md` / `README.md` con esas mismas tools antes de asumir
estructura. No hace falta decirle que "no tiene" checkout local ni bash — simplemente no
están en `tools[]`, y el prompt nunca menciona lo que no tiene.

## Receta 4 — Agente con checkout local y validación

```yaml
tools:
  - read_file
  - grep_files
  - list_dir
  - write_file
  - edit_file
  - name: bash_run
    allow:
      - 'uv run ruff check *'
      - 'uv run pytest *'
      - 'git status'
      - 'git diff *'
      - 'git add *'
      - 'git commit *'
    deny:
      - 'git push --force *'
      - 'rm *'
```

Las write tools materializan el worktree automáticamente; el prompt no debe crear branches
ni worktrees a mano (el bloque `## Git context` ya le dice dónde está parado).

## Receta 5 — Revisor read-only encadenado

Un segundo agente sin write tools **hereda** el worktree que dejó el builder:

```yaml
- id: revisor
  statusName: 'In Review'
  tools: [read_file, grep_files, add_task_comment]
  onFinish: 'Ready to Merge'
  onError: '$set:status=In Progress'
```

## Anti-patrones

| Síntoma | Causa | Fix |
| --- | --- | --- |
| El agente nunca corre; logs dicen `rejected: unscoped` | Sin `statusName` ni `when` | Agregar uno de los dos |
| El agente corre en loop sobre el mismo issue | El outcome no lo saca del criterio activador | Cerrar el ciclo (ver `activation-and-outcomes.md`) |
| Se borraron labels que nadie tocó | Se asignó un campo multi-valor en vez de operarlo (`Labels==x` o un token `=` de más) | Usar `+`/`-`; reservar `=` para cuando querés definir el set completo |
| Un outcome copiado de un ejemplo viejo no hace nada | Usa `on*Labels` / `$labels:`, que ya no existen | Mover los tokens al `$set:` del mismo slot como campo `Labels` |
| `{{task.branch}}` vacío | Agente sin write tools y sin `requiresBranch: true` | Poner `requiresBranch: true` |
| El agente "no ve" tools que declaró | `bash_run` declarado como string en vez de objeto, o alias mal escrito | Usar la entry objeto con `allow`; verificar aliases |
| `providerConfig` ignorado | Campo ajeno al schema strict del provider | Quitar el campo o corregir el provider |
| Un agente global le gana a uno del proyecto | Se esperaba que `position` decidiera entre scopes | La especificidad manda: dale `projectId` al que debe ganar |
| El issue se skipea silenciosamente | Tiene dependencias abiertas y `allowBlocked: false` | Decidir a propósito: `true` para agentes de refinamiento |
| Un MCP hizo algo que las políticas prohibían | Las políticas del engine no aplican a MCP | Restringir el token / el server MCP, no `bash_run` |

## Cómo escribir el `prompt`

Estructura que funciona bien en este engine:

1. **Rol en una línea** — "Eres el refinador técnico de X".
2. **Contexto del issue** con variables (`{{task.title}}`, `{{task.description}}`,
   `{{task.repos}}`, `{{task.branch}}`).
3. **Cómo explorar** — qué tools usar, qué archivos leer primero (CLAUDE.md, AGENTS.md).
4. **Formato exacto del output** (plantilla markdown literal si escribe un documento).
5. **Reglas duras** — qué NO hacer, verificado contra el código real, no asumido.
6. **Cierre** — el prompt SIEMPRE debe decir explícitamente que hay que llamar
   `complete_task`/`fail_task` para terminar; un `end_turn` natural sin llamarlas aplica
   igual `onFinish`/`onError`, pero no deja comentario en el issue (ambas son internas —
   no hace falta declararlas en `tools[]`, ver `tools.md`). La forma de indicarlo cambia
   según el provider:
   - **Sync (`anthropic-api`)**: detalla qué va en cada bullet de `what_did` /
     `validations` / `notes` — eso es literalmente el comentario que va a quedar
     publicado, así que el prompt debe guiar su contenido (archivos tocados, PR/branch,
     validaciones corridas), no solo decir "llamá complete_task".
   - **Async (`tmux-claude`/`iterm-claude`)**: mismo cierre, pero la sesión de terminal no
     tiene tool-calling nativo — el engine ya le agrega el bloque `## Herramientas
     disponibles` con el `curl -X POST <daemonUrl>/api/tools/complete_task` de ejemplo
     (`buildToolInstructions`, automático para internas, tampoco requiere declararlas en
     `tools[]`). Pero que el curl esté disponible no basta: el prompt tiene que decirle al
     modelo, en la sección de Cierre, que ejecute ese curl al terminar — si no, la sesión
     puede terminar sin cerrarla nunca y el run queda colgado hasta que el watchdog de
     liveness lo detecte.
   - Deja explícito cuándo llamar `fail_task` en vez de improvisar (ambigüedad de
     producto, PRD incompleto, bloqueo real) — no lo des por hecho en silencio.

Lo que el engine ya hace y el prompt **no** debe intentar: elegir nombre de branch, crear
worktrees, mover el status/labels al terminar (eso son los outcomes).

## Depuración

- Logs del daemon (`createLogger` → `daemon.log`): busca `agent-selection` /
  `run-context` con `rejected: <razón>: <ids>` para saber qué filtro descartó a cada
  candidato.
- `execution_logs` guarda por run: `agentId`, `providerId`, `outcome`
  (`success|error|cancelled|truncated`), `errorMsg`, `stopReason`, y la sesión OS si fue
  un provider async.
