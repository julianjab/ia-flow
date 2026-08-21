# Providers, MCP y entorno git

## Providers disponibles

| `provider` | `kind` | Cómo corre | Tools |
| --- | --- | --- | --- |
| `anthropic-api` | sync | Llama la Messages API desde el server y corre el loop de tool-calls dentro del engine | Tools del engine, con sandbox (`writePaths`, política de `bash_run`) |
| `tmux-claude` | async | Lanza el CLI `claude` en una sesión tmux | El CLI tiene sus propias tools; las del engine se exponen como appendix curl vía `POST /api/tools/:name` |
| `iterm-claude` | async | Igual, en una pestaña de iTerm2 | Idem |

Los async devuelven una `SessionHandle`; el run se cierra después, cuando el agente llama
`complete_task` / `fail_task` (o el watchdog detecta que la sesión murió).

Elige `anthropic-api` salvo que necesites explícitamente una sesión interactiva/observable
o el toolset completo del CLI de Claude.

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
servidor MCP referenciado expone **todas** sus tools al agente, sin poder acotar. Además el
beta header que usa (`mcp-client-2025-04-04`) es la versión deprecada del conector. Si
necesitas limitar qué puede hacer el agente contra un MCP server, no lo expongas completo —
hoy no hay knob más fino.

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

`agents/<deploy>/` con: `agents.*.yaml`, `projects.yaml`, `repos.yaml`, `mcp-catalog.yaml`,
`Dockerfile`, `docker-compose.yml`, `.env`. Los repositorios YAML son **read-only** (sin
CRUD en runtime) y se activan con `IA_FLOW_*_REPO=yaml`. `repos.yaml` necesita `path`
aunque ningún agente lea el repo localmente: sin él, el orchestrator intenta clonar y
`upsert()` falla en modo YAML.
