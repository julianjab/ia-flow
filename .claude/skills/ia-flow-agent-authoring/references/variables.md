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
| `{{task.comments}}` | Comentarios formateados `[fecha]\ncuerpo`, uno por bloque. |
| `{{task.repo}}` | Repo actual (sólo si `task.repos` tiene exactamente 1; vacío si 0 o varios). |
| `{{task.repo.name}}` `.path` `.github` `.workflow` `.context` `.tree}}` | Datos del repo actual. `tree` acepta profundidad: `{{task.repo.tree.3}}` (default 2). |

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
