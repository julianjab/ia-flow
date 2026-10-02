# apps/runner-v2

El runner headless: lee una config (`runner.yaml` + `projects/`), monta `@ia-flow/agent-engine` y
recibe webhooks de GitHub y mensajes de Slack. Qué agente corre y cuándo es **dato** de la config,
no código de acá. El modelo completo (pipelines, intake, providers, MCP) está en el `README.md`.

## Dónde va cada cambio

| Carpeta de `src/` | Qué hay | Va acá si… |
| --- | --- | --- |
| `main.ts`, `cli.ts`, `boot.ts` | arranque, argumentos, composición | cambia cómo se ensambla el runner |
| `config/` | `runner.yaml` → `RunnerConfig` (con su catálogo de `systemPrompts`), `IA_FLOW_HOME` | agregás o cambiás una clave de la config |
| `http/` | servidor, router, SSE — el borde, sin lógica | cambia cómo se recibe un request |
| `intake/` | webhook o Slack → evento de task (`item.*`, `task.*`) | cambia qué ven las pipelines de un evento |
| `actions/` | contrato, loader y catálogo built-in (`builtin/`) | registrás una acción estándar del runner |
| `engine/` | montar el engine, scope por proyecto, marca Working | cambia cómo corre el engine en el runner |
| `providers/` | providers, hosts remotos y su telemetría | un provider nuevo o un cambio de hosts |
| `mcp/` | catálogo de MCP y `mcpHost` | un MCP nuevo o cómo se publica |
| `github/` | la identidad de GitHub del runner y el login de la web (device flow) | cambia cómo se autentica el runner o una persona |
| `board/` | el `Board` de cada proyecto: Project v2 o issues con labels, y su registro (`Boards`) | cambia dónde vive el estado de una task o cómo se traducen sus webhooks (`project.yaml` → `board:`) |
| `inbox/` | la bandeja de la web, su API, tareas, ingresos | la web necesita ver o hacer algo |
| `assistant/` | el asistente de la web | cambia el asistente |
| `storage/` | SQLite: actividad, conversaciones, ejecuciones | cambia qué se persiste |
| `telemetry/` | OTLP, heartbeat | trazas, logs, métricas |
| `workspace/` | clones y worktrees de las tasks | cambia dónde o cómo trabaja un agente en disco |
| `capabilities/` | los agentes de las capacidades del runner (asistente, `whenText`, `fileFocus`, `branchName`) | cambia el prompt o el modelo de una capacidad, o el asistente |
| `bundle/` | módulos virtuales para las acciones de una config | una config necesita importar otro paquete |

Una tool genérica de GitHub o de Slack **no va acá**: va en `packages/github/tools` o
`packages/slack/tools`, y `actions/builtin/` sólo la registra. Un prompt o un pipeline de un deploy
tampoco: va en la config de ese deploy.

## Comandos

```bash
bun test --cwd apps/runner-v2                       # la suite
bun test --cwd apps/runner-v2 src/intake/branch.test.ts   # un archivo
bun run --cwd apps/runner-v2 typecheck
bun run runner                                      # carga y valida tu .config local sin servir
bun run release:package                             # el bundle: dist/artifacts/ia-flow-runner.js
```

## Lo que no dice el código

- **Las fronteras entre carpetas las verifica `bun run lint:boundaries`** (en `check`): `http/`
  sólo llega a `intake/`, `intake/` no conoce ninguna feature, nada importa `main.ts`.
- **`--config` (o `RUNNER_CONFIG`) apunta al `runner.yaml` a correr**, o a una carpeta (su
  `runner.yaml`). En local, un `runner.local.yaml` junto al de un deploy (gitignoreado) que reusa
  sus agentes y pipelines con las mismas rutas: para La Haus, `la-haus/claw-agents` →
  `agents/ai-development-flow/config/runner.local.yaml`. `apps/runner-v2/.config/` (no versionada)
  sigue siendo el default si no se dice nada.
- **Una config vive en cualquier carpeta**: sus acciones
  resuelven `@ia-flow/*` y `zod` por los módulos virtuales (`bundle/`). Si una config importa un
  paquete que no está en `bundle/modules.ts`, rompe al arrancar: validala con `bun run runner`.
- **El estado va a `IA_FLOW_HOME`** (default `~/.local/state/ia-flow/runner`): la base
  (`runner.sqlite`), los workspaces y la memoria. Nunca dentro del repo.
- **Ningún test depende de una config de deploy.** Un test que necesite una config la arma en el
  tmp del sistema (ver `actions/loader.test.ts`).
