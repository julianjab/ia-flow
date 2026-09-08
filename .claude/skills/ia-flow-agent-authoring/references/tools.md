# Tools y permisos

`tools[]` es una lista plana. Cada entrada es el **nombre** de una tool (string) o —sólo
para `bash_run`— un objeto con su política. `compilePolicy`
(`packages/tools/src/policy.ts`) la convierte en el set efectivo.

**Sin `tools[]` (o vacío) el agente no tiene ninguna tool.** No hay preset ni fallback.
Vale para sync y async por igual (`Agent.ts` normaliza `agentDef.tools` ausente a `[]`
antes de pasarlo al provider — dejarlo en `undefined` haría que `resolveTools` lo lea
como "sin filtro" y exponga TODAS las tools registradas en el appendix curl de un
provider async, no ninguna).

## Catálogo

### Ciclo de vida (internas — no se declaran en `tools[]`)

| Tool | `providerKinds` | Qué hace |
| --- | --- | --- |
| `complete_task` | **`['async']`** | Cierra el run con éxito: publica un comentario estructurado (# agente + Qué hice + Validaciones) y aplica `onFinish`. Si el agente declara `output`, su schema se **especializa** con esos campos (`specialize()`, mismo mecanismo que arma el enum de `select_exit`) — puede recibirlos inline y cerrar en una sola llamada, sin pasar por `submit_output` antes. |
| `fail_task` | `['sync','async']` | Cierra el run como fallido: comentario (# agente ❌ + Qué intenté + Dónde falló) y aplica `onError`. |
| `submit_output` | `['sync','async']` | Entrega la salida ESTRUCTURADA que otro paso va a LEER por programa (no prosa para un humano). Ver § `output` / `submit_output` más abajo. |

**`complete_task` NO está siempre disponible — es async-only.** A un provider sync
(`anthropic-api`) ni siquiera se le ofrece: `resolveTools` la saca de las definiciones que
van a la API por su `providerKinds`, y si el modelo la llama igual porque el prompt se lo
pidió, `resolveExecutableTool` la rechaza y el modelo recibe
`Error: tool 'complete_task' not found`. Es un error real que ya pasó — ver el comentario
de `resolveExecutableTool` en `packages/tools/src/engine.ts`, escrito por ese incidente.

`fail_task` sí está en los dos. Es la ÚNICA forma que tiene un agente sync de señalar un
fallo intencional, por la razón del cuadro de abajo.

#### Cómo cierra un run según el kind

| | Éxito | Fallo intencional |
| --- | --- | --- |
| **sync** (`anthropic-api`) | terminar el turno con el resumen en texto (`end_turn`). El engine infiere éxito del `stopReason`, **publica ese texto final como comentario del issue** (`# <agentId>\n\n<texto>`, Agent.ts) y aplica `onFinish`. | `fail_task` |
| **async** (`tmux-claude`/`iterm-claude`) | `complete_task` | `fail_task` |

**Para un agente sync, el silencio es éxito.** `stopReason` no distingue "terminé bien" de
"me rindo": los dos son `end_turn`. Un prompt sync que no nombra `fail_task` no tiene
ninguna forma de reportar un fallo — el run que se dio por vencido se cierra como exitoso y
aplica `onFinish`, moviendo el issue hacia adelante con el trabajo sin hacer. Frases como
"terminá con un error explícito" o "la task quedará en su estado actual" **no son
ejecutables**: si el prompt no nombra `fail_task`, no pasa nada de eso.

### `output` / `submit_output` — handoff estructurado entre agentes

Un agente cierra con prosa, y esa prosa es lo que el engine publica como comentario del
issue — sirve para un humano, no para el paso siguiente: nadie puede leer "el brief para el
implementer" de un párrafo sin volver a llamar a un modelo. `AgentDefinition.output`
(`AgentOutputSchema`) es el contrato de lo que SÍ tiene que leerse por programa:

```yaml
output:
  actionable:
    type: boolean
    description: 'true si el comentario pide un cambio real.'
  summary:
    type: string
    description: 'Qué hay que hacer, para el agente que reciba el encargo.'
    optional: true
```

- **Es opt-in y sin default.** La mayoría de los agentes cierra con prosa y alcanza. Declarás
  `output` cuando otro paso necesita LEER lo que este produjo — y declararlo lo vuelve
  **obligatorio**: el run falla si el agente cierra sin entregarlo. Un contrato que se puede
  incumplir en silencio es peor que no tener contrato.
- **`submit_output` es el canal, y funciona igual en sync y en async** — es justo por eso que
  existe como tool en vez de usar `output_config.format` de la Messages API (que sólo aplica a
  `anthropic-api` y no haría nada en tmux/iterm, el mismo modo de falla que los `fs_*` en
  terminal). Un payload inválido vuelve como error de tool y el modelo corrige — no mata el run.
- **No cierra el run.** Es una entrega ANTES del cierre; el agente la llama y después cierra
  como siempre (`fail_task`, `complete_task`, o silencio-éxito en sync).
- **En async, `complete_task` puede recibir los mismos campos inline** (ver tabla de arriba):
  ahorra la segunda llamada cuando no hace falta entregar antes de terminar. `submit_output`
  sigue sirviendo para un run largo que quiere asegurar su salida antes de seguir trabajando, o
  para dejarla disponible aunque después falle (`fail_task` no la descarta).
- **Se lee con `{{task.previous_outputs}}`** (`references/variables.md`) — la última entrega de
  cada agente distinto que corrió sobre la task, no un historial completo.
- ⚠️ **Persistencia:** hoy `output` sólo sobrevive en un deploy headless (`runner.yaml`, parseado
  directo con `AgentDefinitionSchema`). Un agente creado o editado desde la UI/API contra la DB
  de este server usa `SqliteAgentRepository`, que **no mapea el campo `output`** — se pierde en
  el primer guardado sin aviso. Verificá esto antes de asumir que un agente SQLite puede declarar
  `output`; si el gap sigue sin resolverse, documentalo en el propio issue en vez de asumir que
  funciona.

### Filesystem (lectura)

| Tool | Alias | Notas |
| --- | --- | --- |
| `fs_read` | `read_file` | Path `"<repo-name>/relative/path"` o absoluto. Soporta `offset` / `limit`. Archivos grandes pueden pasar por el simplificador Haiku (`fileSimplifierEnabled`). |
| `fs_list` | `list_dir` | Lista archivos y directorios. |
| `fs_grep` | `grep_files` | Regex + filtro `glob` + `case_insensitive`. |

Ven todos los repos del proyecto (no sólo los del issue) vía `repoPaths`.

### Filesystem (escritura) — sólo provider `anthropic-api`

| Tool | Alias |
| --- | --- |
| `fs_write` | `write_file` |
| `fs_edit` | `edit_file` |

Sólo pueden escribir dentro de `writePaths` (el worktree del task).

### Ejecución — sólo provider `anthropic-api`

`bash_run` (alias `run_command`) es la única tool con configuración propia:

```yaml
- name: bash_run
  allow:
    - 'uv run pytest *'
    - 'git status'
  deny:
    - 'git push *'
```

- **Sin la entry, `bash_run` no existe** para ese agente.
- Sin shell: `Bun.spawn` con argv. **No hay pipes, redirects ni globs** — encadena varias
  llamadas si necesitas un pipeline.
- Matching por tokens: `foo*` prefix-matchea un token; `*` como último token consume el
  resto del comando; sin `*` final el conteo de tokens debe coincidir exacto.
- `deny` gana sobre `allow`; lo que no matchea ningún `allow` se rechaza. **No hay
  excepciones hardcodeadas** — si no pones `deny: ['git push *']`, puede pushear.
- Flags que sacan el sandbox del worktree (`git -C`, `--git-dir`, `--work-tree`) se
  rechazan siempre.
- `cwd` opcional debe estar dentro de `writePaths` (default `writePaths[0]`).
- `timeout_ms` con default y cap propios; la salida combinada se trunca con marca
  `[truncated]`.

### Workspace — sólo `anthropic-api`

| Tool | Alias | Notas |
| --- | --- | --- |
| `workspace_reset` | `reset_worktree` | Descarta el worktree del task y lo rehace limpio. |

### Esperas y pausas — sólo `sync` (`anthropic-api`)

| Tool | Alias | Notas |
| --- | --- | --- |
| `wait_for_event` | — | Termina el run y lo reanuda una regla sobre el evento pedido en `on`. Libera slot, lock y worktree. |
| `pause_until` | `pause_for_message` | Igual, pero retiene el worktree y checkpointea la conversación. Default de `on`: `['task.message']`. |

Las dos toman `on: string[]` (tipos `<evento>.<acción>` del event-catalog de GitHub, no el
nombre del webhook pelado) y `when` (condiciones sobre los campos REALES de ese evento). Sin una
regla sobre `wait.resumed`, el agente se despierta y no vuelve a correr nunca.
→ `references/events-and-waits.md`

### Task / issue (agnósticas al source)

| Tool | Uso |
| --- | --- |
| `update_issue_body` | Reemplaza el body del issue (típico del refinador que escribe un PRD). |
| `add_task_comment` | Comentario de progreso, mismo formato que complete/fail. Para runs largos. |
| `set_task_field` | Escribe un campo del proyecto (`Status`, `Task Type`, `Priority`, `Repos`, `Labels`, …). Misma semántica que el `$set:` de los outcomes: los campos de un valor se asignan, los multi-valor (`Labels`) aceptan tokens `+`/`-`/`=`. |
| `set_task_labels` | Azúcar sobre lo anterior para el caso "añadir labels conservando las existentes": traduce cada label a un `+`. Para quitar o reemplazar, usá `set_task_field`. |
| `mark_blocked_by` | Marca dependencia entre dos issues (útil al splitear en sub-issues). |

### GitHub (requieren contexto de repo/proyecto del source)

| Tool | Uso |
| --- | --- |
| `create_github_issue` | Crea issue y lo agrega al proyecto. Devuelve número + node ID. |
| `add_to_project` | Agrega un issue existente (por node ID) al proyecto. |
| `add_sub_issue` | Enlaza un issue como sub-issue de un padre. |

### Slack

`slack_resolve_permalink`, `slack_read_thread`, `slack_channel_history`,
`slack_post_message`. Requieren el token de Slack configurado en el deploy.

## Efectos secundarios de las tools de escritura

`WRITE_TOOLS = { fs_write, fs_edit, bash_run }`. Tener **cualquiera** de las tres implica:

1. **Worktree materializado** por `WorkspaceManager` (sólo `anthropic-api`): el agente lee
   y escribe dentro de `~/.../worktrees/<task>` en vez del repo base.
2. **Linked branch** creada automáticamente en GitHub antes del run (salvo
   `requiresBranch: false`), disponible como `{{task.branch}}`.

Un agente read-only no crea worktree, pero **sí lo ve** si un agente anterior de la
cadena lo creó (invariante de visibilidad) — así el revisor lee lo que el builder escribió.

Si el agente escribe código **sólo por MCP de GitHub** (sin tools de escritura locales),
pon `requiresBranch: true` explícito o `{{task.branch}}` llega vacío.

## Tools vs MCP

- Las tools de esta lista corren dentro del engine (`ToolContext`, sandbox, políticas).
- Los servidores MCP (`mcpCatalogIds` / `providerConfig.mcpServers`) son capacidades
  externas que el modelo ve además de estas. El sandbox de `writePaths` y las políticas de
  `bash_run` **no aplican** a lo que haga un MCP: si le das el MCP de GitHub con un token
  con permiso de push, puede pushear aunque no tenga `bash_run`.
