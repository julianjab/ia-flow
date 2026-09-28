# runner-v2

El runner headless de ia-flow sobre [`@ia-tools/agent-pipeline`](https://github.com/julianjab/ia-tools):
recibe los webhooks de GitHub, los traduce a eventos de la task y corre los agentes que le
tocan a cada columna del board. Es el `ai-development-flow` de `ia-tools/examples` traído acá,
con la definición del pipeline como datos y las ejecuciones en SQLite.

## Qué cambia respecto del runner de `apps/server`

- **La definición vive en `.config/`**, en el formato de `@ia-tools/agent-pipeline-yaml`
  (agentes y pipelines del engine), y se recarga en caliente: editar un YAML aplica en el
  próximo evento, sin reiniciar. Una versión inválida se loguea y sigue la última buena.
- **Las ejecuciones persisten en SQLite** (`bun:sqlite`, `.state/executions.sqlite`): una task
  nunca corre dos agentes a la vez, y una pausa —esperar el CI después de abrir el PR— sobrevive
  a un reinicio. Una corrida que el reinicio cortó queda `failed` (`interrupted`) y lo que no
  llegó a leer se vuelve a despachar.

## `.config/`

```
.config/
├── engine.yaml                  el engine: store de ejecuciones, fuentes, tick de pausas
├── runner.yaml                  identidad de GitHub, providers, MCP y el board de cada proyecto
└── projects/lahaus-ai-flow/
    ├── project.yaml             filtro del proyecto, system prompts compartidos, onError
    ├── agents/*.yaml            QUÉ hace cada agente y cómo termina (sus salidas)
    ├── pipelines/*.yaml         CUÁNDO corre (una pipeline por columna/evento)
    └── repos/*.yaml             el catálogo de repos (lo lee el runner, no el engine)
```

Lo que el YAML nombra y el runner implementa (`src/catalog/buildCatalogs.ts`):

| Nombre | Qué es |
| --- | --- |
| `update_issue`, `post_comment` | transiciones del board y el comentario de cierre (firmado por el agente) |
| `react_to_comment`, `review_pull_request`, `pr_checks`, `create_github_issue`, … | las tools de GitHub del proyecto |
| `fs_read`, `fs_list`, `fs_grep`, `fs_write`, `fs_edit`, `bash_run` | disco sobre el worktree de la task; `bash_run` con `options` (`allow`, `deny`, `githubAuth`, `timeout`, `maxTimeout`) |
| `issue_body` | las tools del body del issue que el agente puede tocar (`options: { write, check }`) |
| `blockedReport` | el reporte de una corrida que falló (el `onError` del proyecto) |

## Correr

Los paquetes de ia-tools todavía no se publican: se consumen con `bun link` desde un clon de
ia-tools al lado de ia-flow (`IA_TOOLS_DIR` si está en otro lado), instalado y compilado.

```bash
# una vez por máquina (y cuando se agregue un paquete)
(cd ../ia-tools && pnpm install && pnpm build)
bun run --cwd apps/runner-v2 link:ia-tools
bun install

cd apps/runner-v2
bun run dry-run                                   # carga y valida la definición, sin credenciales
bun run src/main.ts issue.status_changed la-haus/subscriptions#123 --status Refine --label blocked --dry-run
IA_FLOW_WEBHOOK_SECRET=... bun run serve         # servidor de webhooks (escrituras simuladas)
IA_FLOW_WEBHOOK_SECRET=... bun run serve --live  # escrituras reales a GitHub
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

## Lo que no se portó del ejemplo

- Las tools `memory_*` del implementer: el runner no las tiene (tampoco el ejemplo).
- La regla `unblock-dependents-on-merge`: era un script de Python del deploy de claw-agents.
- Los `settings` del runner de `apps/server` que este runner no implementa (API, websocket,
  polling, remote providers): `runner.yaml` sólo acepta lo que se usa.
