# Variables de prompt y system prompts

Sintaxis única: `{{path}}`. Una variable desconocida **se deja literal** en el prompt (con
un `debug` en logs) — no falla el run. Por eso hay que verificar los nombres contra este
catálogo: un typo es un bug silencioso.

Catálogo real en `apps/server/src/variables/{system,project,task,custom}.ts`.

## Grupo `system`

| Variable | Contenido |
| --- | --- |
| `{{daemon_url}}` | URL base del daemon (ej. `http://localhost:3001`). |
| `{{system.date}}` | Fecha actual `YYYY-MM-DD`. |
| `{{system.tools}}` | Tools disponibles para este agente, separadas por coma. |
| `{{system.variables_catalog}}` | Catálogo completo de variables — útil en el system prompt de un agente que escribe prompts de otros. |

## Grupo `task`

| Variable | Contenido |
| --- | --- |
| `{{task.id}}` | ID interno (el que se pasa a `complete_task` / `fail_task` / tools de task). |
| `{{task.title}}` | Título del issue. |
| `{{task.description}}` | Body completo. |
| `{{task.repos}}` | Repos del issue, separados por coma. |
| `{{task.branch}}` | Branch canónica preparada por el engine (linked branch o `task/<id>`). |
| `{{task.issueUrl}}` | URL del issue en GitHub. |
| `{{task.comments}}` | Comentarios formateados `[fecha]\ncuerpo`, uno por bloque. Los propios comentarios del engine (`complete_task`/`fail_task`/`add_task_comment`) NO aparecen — se filtran por marcador de sistema. Un comentario humano se marca "leído" en GitHub (best-effort) cuando el agente que matchea el dispatch tiene la variable en su prompt — desde ese momento el marcador queda en el comentario y **ningún** agente futuro (de este ni de otro paso del pipeline) lo vuelve a ver, así que si sólo un paso mira `{{task.comments}}`, ningún otro consumió nada (no había marca que poner); pero si dos pasos distintos la usan, el que corra primero apaga el comentario para el que corra después. No hay tracking por-agente — es un flag global "ya lo leyó alguien". Si dos pasos necesitan ver el MISMO comentario de forma independiente, este mecanismo no lo soporta hoy — el agente tendría que dejar la evidencia en otro lado (ej. un campo del task) para que el paso siguiente la lea sin depender de `{{task.comments}}`. |
| `{{task.repo}}` | Repo actual (sólo si `task.repos` tiene exactamente 1; vacío si 0 o varios). |
| `{{task.repo.name}}` `.path` `.github` `.workflow` `.context` `.tree}}` | Datos del repo actual. `tree` acepta profundidad: `{{task.repo.tree.3}}` (default 2). |
| `{{task.previous_outputs}}` | La última salida estructurada (`submit_output`) de cada agente distinto que corrió sobre esta task, una por agente, formateada `[agentId]\n<json>`. Vacío si ninguno entregó salida todavía. Ver `references/tools.md` § `submit_output`. |
| `{{task.pr.number}}` / `{{task.pr.url}}` | Número y URL del **primer PR abierto** de la task. Vacío (los dos) si no hay ninguno. Vienen de la misma selección que ya se pide en el dispatch — cero llamadas nuevas. |
| `{{task.pr.files}}` | Archivos tocados por ese PR, uno por línea (`path (+adds/-dels)`). También gratis — misma selección que `number`/`url`/`ci`. |
| `{{task.pr.diff}}` | Diff unificado del PR, recortado a un tope de caracteres. **Lazy:** sólo dispara un fetch a GitHub si el prompt referencia esta variable (`promptReferencesVariable`) — un agente que no la usa no paga el request. |
| `{{task.ci}}` | Estado del CI del último commit del PR abierto (`success`/`failure`/`error`/`pending`/`expected`). Vacío si no hay PR abierto o no tiene checks configurados. |
| `{{task.labels}}` | Labels del issue, separadas por coma. |
| `{{task.status}}` | Status actual de la task en el source (columna del board o estado del issue). |

**Por qué importan `task.pr.*`/`task.ci`:** antes de que existieran, un agente que necesitaba el
número de PR o el estado del CI tenía que descubrirlo por MCP/`gh` — 3-6 turnos reconstruyendo
algo que el dispatch ya había resuelto. Usalas siempre que el prompt vaya a preguntar "¿hay PR?"
o "¿el CI está en verde?": es más barato que el round-trip, y para `task.pr.number`/`.url`/`.files`/
`task.ci` no cuesta nada adicional (van en la misma query). Sólo `task.pr.diff` tiene costo real,
de ahí el gate lazy — no la referencies si con `task.pr.files` alcanza.

## Grupo `project`

| Variable | Contenido |
| --- | --- |
| `{{project.name}}`, `{{project.language}}` | Del `ProjectSettings`. |
| `{{project.fields.FIELD}}` | Opciones del campo FIELD del GitHub Project (ej. `{{project.fields.priority}}`). |
| `{{project.repos}}` | Lista markdown `- name — description`. |
| `{{project.repos.names}}` | Nombres separados por coma. |
| `{{project.repos.NAME}}` | Descripción del repo NAME. Subcampos: `.path`, `.github`, `.workflow`, `.context`, `.tree[.N]`. |

`.tree` usa `git ls-files` si el repo es git (respeta `.gitignore`), si no un walk con
ignore-list fija. Vacío si el repo no tiene `path`.

## Grupo `custom`

Definidas en el propio agente:

```yaml
variables:
  CONVENTIONS:
    value: 'snake_case en payloads y DB'
    full: 'Texto largo con todas las convenciones...'
    description: 'Se muestra en el editor web'
```

Uso: `{{variables.CONVENTIONS}}` y `{{variables.CONVENTIONS.full}}`. La forma corta
(`CONVENTIONS: 'texto'`) también vale.

## Contextos: qué se puede usar dónde

| Contexto | Grupos permitidos |
| --- | --- |
| `agent-prompt` (campo `prompt`) | `system`, `project`, `task`, `custom` |
| `system-prompt` (campo `systemPrompts`) | **sólo** `system` |

Usar una variable fuera de su contexto no rompe el run, pero deja un `warn` en logs y el
valor puede no tener sentido. Regla práctica: **nada de `{{task.*}}` en un system prompt** —
los system prompts son estables entre runs (y cacheables), el prompt de usuario es el que
lleva el contexto del issue.

## Composición de system prompts

`resolveSystemPromptBlocks` concatena, en este orden:

1. `project.settings.systemPrompts[]` — default del proyecto, aplica a **todos** sus agentes.
2. `SystemPromptDef` con `default: true` visibles en el scope (global o del proyecto).
3. `agent.systemPrompts[]` — lo que el agente eligió, en su orden.

Cada entrada es un id de `SystemPromptDef` o texto inline `{text: "..."}`; se pueden
mezclar. Un id ya incluido por (1) o (2) no se duplica.

**Dónde poner qué:**

- Reglas transversales al pipeline (idioma, "nunca mergees", límites de alcance) →
  `project.settings.systemPrompts`. Se escriben una vez para todos los agentes.
- Rol y método específico de un agente → su `prompt`.
- Bloque reusable entre algunos agentes → `SystemPromptDef` con id, referenciado por los
  que lo necesitan.
