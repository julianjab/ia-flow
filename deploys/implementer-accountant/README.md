# Implementer contra julianjab/accountant

Instancia de [`apps/agent-runner`](../../apps/agent-runner/README.md) (ver
ahí el mecanismo genérico: cómo se levanta, modo webhook/polling, auth,
logs, cambiar config sin rebuild). Esta carpeta solo tiene la config
puntual de este deploy: un solo agente (`accountant-implementer`) que toma
issues de [`github.com/julianjab/accountant`](https://github.com/julianjab/accountant)
y escribe código real — branch, commits y Pull Request — usando el **MCP
oficial de GitHub**, sin checkout local (el agente no tiene `fs_write` ni
`bash_run`, solo `mcpCatalogIds: [github-mcp]`; ver `agents.implementer.yaml`).

## Flujo de labels (status vía label, un solo `status:*` a la vez)

Este source es `github-issues` (`packages/issue-sources/src/github-issues/`),
así que el status del issue vive en un label `status:<nombre>`, y
`StatusLabelCodec` garantiza que solo hay UNO presente a la vez (mutación
reemplaza, no acumula). El roster define:

| Paso | Label antes | Trigger | Label después |
| --- | --- | --- | --- |
| Toma la tarea | `status:build` | `statusName: build` matchea | — |
| Empieza a correr | `status:build` | `onProcess` | `status:working` |
| Termina bien (PR abierto + comentario en el issue) | `status:working` | `onFinish` | `status:done` |
| Falla (excepción, PR rechazado, PRD incompleto) | `status:working` | `onError` | `status:blocked` |

`statusName: build` ya es la única condición de entrada — un issue en
`status:working`/`status:done`/`status:blocked` **no puede** tener también
`status:build` (un solo label a la vez), así que el engine nunca lo vuelve a
tomar mientras está en cualquiera de esos otros 3 estados. No hace falta un
`when` adicional para excluirlos explícitamente; agregar uno sería
redundante con esta garantía del codec (ver comentario en
`agents.implementer.yaml`).

Antes de correr esto contra el repo real, creá en
`github.com/julianjab/accountant`:

- Las labels `status:build`, `status:working`, `status:done`, `status:blocked`.

No hay label ancla: `projects.yaml` corre sin `anchorLabel`, así que el
engine escanea TODO issue abierto del repo. Lo que decide qué se ejecuta es
`status:build` — un issue sin esa label entra al scan y no matchea ningún
agente. En la práctica, marcar un issue con `status:build` es lo que lo mete
al pipeline; normalmente ya viene con un PRD funcional aprobado (paso previo
de refinamiento, fuera del alcance de este deploy).

Si el repo pasa a tener issues ajenos al engine, poné `anchorLabel: <label>`
en `projects.yaml`: es la única forma de excluir un issue del scan de
entrada (el health del source lo reporta como warning mientras no esté).

## Auth de Claude — CLAUDE_CODE_OAUTH_TOKEN, no ANTHROPIC_API_KEY

El provider sigue siendo `anthropic-api` (`AnthropicApiProvider.id`, ver
`agents.implementer.yaml`) — lo que cambia es la credencial. Este deploy usa
`CLAUDE_CODE_OAUTH_TOKEN`: `buildAnthropicAuthHeader`
(`packages/ai-providers/src/anthropic-api/auth.ts`) lo prioriza sobre
`ANTHROPIC_API_KEY` cuando ambos están seteados, así que alcanza con setear
uno solo. Generalo con `claude setup-token` desde el CLI de Claude Code (o
donde ya tengas uno emitido para uso headless/CI) y pegalo en `.env`.

## GitHub — token, no GitHub App

`GITHUB_TOKEN` es un **Personal Access Token** (classic o fine-grained) con
permisos de escritura sobre `contents`, `pull_requests` e `issues` del repo
`accountant` — lo consume tanto el source `github-issues` (leer/mover el
issue) como el MCP remoto de GitHub (escribir el código), mismo token para
los dos (ver `mcp-catalog.yaml`). Generá el token en
[github.com/settings/tokens](https://github.com/settings/tokens) (o
fine-grained en `settings/personal-access-tokens`) apuntado al repo
`julianjab/accountant`.

## Run

```bash
cd deploys/implementer-accountant
cp implementer.env.example .env   # completar CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN, etc.
docker compose up -d --build      # o: podman compose up -d --build
```

Modo webhook (default) — mapea el proxy a `127.0.0.1:8787`. Ver
[README de agent-runner](../../apps/agent-runner/README.md) para el detalle
del túnel + secret del webhook, y cómo cambiar a modo `polling`.
