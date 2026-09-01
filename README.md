# ia-flow

Orquesta agentes de IA contra repos locales y fuentes de issues (GitHub Projects,
GitHub Issues, filesystem). Monorepo Bun: un server Hono + SQLite, una SPA Vue 3,
y los paquetes que comparten.

La guía profunda de arquitectura está en [CLAUDE.md](./CLAUDE.md); esto es lo
mínimo para levantarlo.

## Requisitos

- **[Bun](https://bun.sh)** — el único package manager y runtime del repo (nada de npm/pnpm/yarn).
- **git** — el provisioner de workspaces clona, crea worktrees y pushea.
- **Una credencial de Anthropic** — ver abajo.
- Opcional: `gh` CLI o un PAT/GitHub App si vas a usar GitHub como fuente de issues.

## Credenciales de Anthropic — obligatorias para usar la API

**Para usar el proveedor `anthropic-api` tenés que definir tu propia API key de
Anthropic.** ia-flow no incluye ni provee credenciales: llama a la API de
Anthropic con las tuyas, y el consumo se factura a tu cuenta bajo los términos
de Anthropic.

Se acepta una de estas dos variables de entorno, en este orden de precedencia
(`packages/ai-providers/src/anthropic-api/auth.ts`):

| Variable | Qué es |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | token OAuth de Claude Code — gana si está seteado |
| `ANTHROPIC_API_KEY` | API key de la [consola de Anthropic](https://console.anthropic.com/settings/keys) |

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Sin ninguna de las dos, cualquier run contra la API falla con
`No auth configured: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY`.

También las usan piezas que no son el loop del agente: la extracción con Haiku
del `focus` de `fs_read` (`IA_FLOW_FILE_SIMPLIFIER`, default encendido), el
nombrador de branches y el gate `whenText` de selección de agentes.

Las dos se pueden pegar desde la UI (**Configuración → grupo Anthropic**), que
las guarda en SQLite y las vuelca al entorno del proceso al bootear — o dejarlas
en el `.env` / el entorno del contenedor. **Nunca las commitees.**

> Los providers de terminal (`tmux-claude`, `iterm-claude`) usan la sesión ya
> autenticada del CLI de `claude`: ahí la credencial la maneja el CLI, no ia-flow.

## Arranque

```bash
bun install
bun run dev          # server (3001) + web (5173) en paralelo
```

| Var | Qué mueve | Default |
| --- | --- | --- |
| `IA_FLOW_SERVER_PORT` | puerto del server y destino del proxy de la web | `3001` |
| `IA_FLOW_WEB_PORT` | puerto del dev server de Vite | `5173` |
| `IA_FLOW_CONFIG_DIR` / `IA_FLOW_DB_PATH` | dónde vive la config y el SQLite | `~/.config/ia-flow` |

El resto de la configuración se edita desde la UI.

## Layout

```
apps/server/        API Hono + WebSocket + SQLite (flavors: full | runner)
apps/web/           SPA Vue 3 + Vite + Pinia
apps/agent-host/    Host remoto de providers (corre runs en otra máquina)
apps/desktop/       Visor Electron de la SPA
packages/           shared, workspace, github-auth, figma-auth, slack, tools,
                    ai-providers, agent-engine, issue-sources, rules
```

## Comandos

```bash
bun run dev          # server + web
bun run build        # shared → server → web
bun run test         # todos los workspaces
bun run typecheck    # todos los workspaces
bun run lint         # biome
bun run check        # biome + typecheck + test  ← correlo antes de pushear
```

## Deploy

No se publican imágenes: cada release publica **bundles** (`ia-flow-server.js`,
`ia-flow-runner.js`, `ia-flow-agent-host.js`) que se referencian con un `ADD`
desde el Dockerfile de quien los usa. Ver el `Dockerfile.example` al lado de
cada app, [apps/server/RUNNER-DEPLOY.md](./apps/server/RUNNER-DEPLOY.md) y
[apps/agent-host/README.md](./apps/agent-host/README.md).

Acordate de pasarle al contenedor la credencial de Anthropic como secreto
(`ANTHROPIC_API_KEY` o `CLAUDE_CODE_OAUTH_TOKEN`) — no va horneada en ningún
artefacto.

## Licencia

[MIT](./LICENSE). ia-flow no incluye credenciales ni acceso a modelos: usar el
proveedor de Anthropic requiere tu propia API key y queda sujeto a los términos
de servicio de Anthropic.
