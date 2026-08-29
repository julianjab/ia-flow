# Providers, MCP y entorno git

## Providers disponibles

| `provider` | `kind` | Cómo corre | Tools |
| --- | --- | --- | --- |
| `anthropic-api` | sync | Llama la Messages API desde el server y corre el loop de tool-calls dentro del engine | Tools del engine, con sandbox (`writePaths`, política de `bash_run`) |
| `tmux-claude` | async | Lanza el CLI `claude` en una sesión tmux | El CLI tiene sus propias tools; las del engine se exponen como appendix curl vía `POST /api/tools/:name` |
| `iterm-claude` | async | Igual, en una pestaña de iTerm2 | Idem |
| `remote:<name>` | **lo declara el agent-host** | Delega en un `agent-host` remoto, que corre el provider que diga SU `agent-host.json` | Las del provider que el agent-host resuelva |
| `remote:*` | **varía por dispatch** | Comodín: expande a todos los agent-hosts registrados y toma el primero que admite | Idem |

Los async devuelven una `SessionHandle`; el run se cierra después, cuando el agente llama
`complete_task` / `fail_task` (o el watchdog detecta que la sesión murió).

Elige `anthropic-api` salvo que necesites explícitamente una sesión interactiva/observable
o el toolset completo del CLI de Claude.

### El kind de un `remote:` no se puede saber desde el YAML

`RemoteAgentProvider.kind = registration.remoteKind`, y ese valor lo aporta el agent-host
cuando se registra (`routes/provider-registrations.ts` → `remoteKind: agent-host.entry.kind`).
O sea: es **estado de runtime**, no config del roster. El mismo `remote:<name>` es sync hoy
y async mañana si alguien cambia el `providerId` del `agent-host.json` de esa máquina y lo
reinicia. Con `remote:*` ni siquiera es estable dentro del mismo roster: cada dispatch
puede aterrizar en un agent-host distinto.

**Consecuencia para el prompt:** un agente con `provider: remote:...` (o con un array de
candidatos de kinds distintos) NO puede afirmar de qué kind es. Ver "Cierre del run".

## Cierre del run

Esta es la parte que más se escribe mal. La regla:

> **El prompt nunca afirma el kind del provider. Describe el cierre en términos de lo que
> el modelo puede observar — si tiene la tool o no — no de mecánica interna del engine.**

Bloque canónico, correcto para cualquier provider:

```markdown
## Cierre

- **Éxito** → si `complete_task` está entre tus tools, llamala con `task_id` =
  `{{task.id}}` y el resumen en `what_did` / `validations`. Si no está, terminá tu
  respuesta con ese mismo resumen en texto: el engine lo publica como comentario del
  issue y aplica la transición de éxito.
- **Fallo** (<condiciones concretas>) → llamá `fail_task` con `task_id` = `{{task.id}}` y
  el detalle en `where_failed`. Está siempre disponible.
```

Por qué así y no "este agente corre sync":

- **Es verdad para los dos kinds**, así que sobrevive a que alguien cambie el provider del
  agente, y es la única forma correcta de escribir un `remote:`.
- **El modelo puede verificarlo.** "Corrés sync" es un hecho sobre el engine que el modelo
  no puede comprobar; "¿está `complete_task` entre tus tools?" lo lee de su propio contexto.
- **Falla bien en los dos sentidos.** Si el kind cambia, el agente sigue cerrando bien.

Errores concretos que esto evita:

| Error en el prompt | Qué pasa |
| --- | --- |
| Pedirle `complete_task` a un agente sync | La tool no se le ofrece; si la llama igual recibe `Error: tool 'complete_task' not found` y puede quedar dando vueltas |
| Afirmar "este agente corre sync" con `provider: remote:*` | Mentira la mitad de las veces; le prohíbe al modelo la tool correcta |
| No nombrar `fail_task` | En sync, el run que se rindió cierra como **exitoso** y aplica `onFinish` — ver `tools.md` |
| Explicarle al modelo `providerKinds` / `resolveExecutableTool` | Ruido: mecánica del engine que no puede verificar ni necesita para decidir |

## `providerConfig` (por agente)

Cada provider valida el blob con un schema **strict** propio: un campo de más → la config
se rechaza. No mezcles campos entre providers.

### `anthropic-api`

```yaml
providerConfig:
  model: claude-sonnet-5          # opcional; default del deploy si se omite
  maxTokens: 24000                # entero positivo
  effort: high                    # low | medium | high | xhigh | max
  taskBudgetTokens: 200000        # mínimo 20000
  fileSimplifierEnabled: true     # override del simplificador Haiku en fs_read
  mcpServers: { ... }             # inline; gana sobre mcpCatalogIds
```

Este es todo el schema strict — no hay `temperature`, `top_p`, `stop_sequences`,
`tool_choice` ni `thinking` por agente, aunque la Messages API sí los soporte (algunos,
`thinking` incluido, sólo se configuran a nivel deploy). Antes de pedirle a un agente un
comportamiento que suena a "un parámetro de la API", revisa
`references/anthropic-messages-api.md` — mapea cada parámetro de `POST /v1/messages` contra
lo que este provider realmente envía, y qué hacer en su lugar cuando no está cableado.

### `tmux-claude` / `iterm-claude`

```yaml
providerConfig:
  model: sonnet
  dangerouslySkipPermissions: true
  mcpServers: { ... }
```

## MCP

Catálogo central (`McpCatalogEntry`): `id`, `name`, `description?`, `config`. En deploys
headless vive en `mcp-catalog.yaml`.

```yaml
- id: github-mcp
  name: GitHub MCP
  config:
    type: http
    url: https://api.githubcopilot.com/mcp/
    authorizationToken: ${GITHUB_TOKEN}
```

Tipos de `config`:

- **stdio**: `{ command, args?, env? }` — proceso local lanzado por el CLI de Claude.
  **Sólo providers terminal**: la Messages API descarta las entradas stdio.
- **http / sse**: `{ type, url, headers?, authorizationToken? }` — sirve para ambos.
  Para `anthropic-api`, la auth debe ir por `authorizationToken` (la API no acepta
  `headers`; se extrae el Bearer de `Authorization` como fallback).

El agente los referencia con `mcpCatalogIds: [github-mcp]`; se mergean en
`providerConfig.mcpServers` al dispatch, y los inline del agente ganan sobre los del
catálogo. Los `${VAR}` de cualquier string se interpolan con el env del proceso
(`Bun.env`); una var vacía colapsa a `''` y falla ruidosamente en la API, no filtra el
placeholder.

**Sin filtro por tool.** El conector MCP de la Messages API soporta allowlist/denylist y
`defer_loading` por tool (`MCPToolset` en `tools[]` — ver
`references/anthropic-messages-api.md`), pero `anthropic-api` en ia-flow no lo cablea: un
servidor MCP referenciado expone **todas** sus tools al agente, sin poder acotar. Si necesitas
limitar qué puede hacer el agente contra un MCP server, no lo expongas completo — hoy no hay
knob más fino.

## Entorno git que el engine prepara

El agente **no decide** la estrategia de branching: el engine la prepara y la describe en
un bloque `## Git context` prependido al prompt.

| Caso | Qué recibe el agente |
| --- | --- |
| sync + write tools | Worktree materializado, branch `{{task.branch}}` (o `task/<id>`), base branch detectada, instrucción de push + PR |
| sync read-only | Path de lectura (worktree si existe, si no el repo base) y "no toques git" |
| async, `workflow: main` | Commit directo sobre la base branch |
| async, `workflow: branch` | Branch nueva checkouteada in-place |
| async, `workflow: worktree` | `claude --worktree <branch>` ya aplicado |

`workflow` se define **por repo** (`repos.yaml` / tabla `repos`): `worktree` \| `branch` \| `main`.

Repos del proyecto → `repoPaths`, con el **primer** elemento de `task.repos[]` como repo
primario (define `cwd` y `workflow`). Si el issue apunta a un repo no registrado en el
proyecto, el dispatch se aborta con error en logs.

## Sources (dónde viven los issues)

Configurado en el proyecto (`ProjectSchema.source`):

| `kind` | `config` requerido |
| --- | --- |
| `local` | — (tareas en SQLite) |
| `github` | `url` del GitHub Project v2 |
| `github-issues` | `owner`, `repo`, `anchorLabel` |

`anchorLabel` (en `github-issues`) decide qué issues del repo entran al pipeline de
ia-flow; las labels `agent:*` deciden en qué paso están. Son conceptos distintos.

## Deploy headless

La raíz de un deploy lleva: `runner.yaml` (settings, github, upstream, mcp),
`projects/<projectId>/` (su `project.yaml`, sus `agents/` y sus `repos/`),
`agents/` para los globales, su `docker-compose.yml` y su `.env`. La imagen es
común a todos los deploys y se construye con `apps/server/Dockerfile.runner`.

Los repositorios YAML son **read-only** (sin CRUD en runtime). Ya no hacen falta las
`IA_FLOW_*_REPO=yaml`: el flavor `runner` las usa por construcción, y todo lo que antes
eran env vars del compose —`daemonMode`, `logLevel`, `instanceId`, las URLs de
forward— vive en el bloque `settings` del `runner.yaml`. En el compose quedan sólo los
secretos.

`repos/` es un **catálogo**, no un checkout: mapea el nombre corto a `githubOwner`/
`githubRepo` + una `description` que es el contexto con el que un refiner decide qué
va en qué repo. El `path` es opcional — este flavor no inyecta provisioner de
workspace, así que no clona ni crea worktrees, y un agente sin write tools puede correr
sobre un repo que ni siquiera esté en el catálogo.
