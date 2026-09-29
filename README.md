# ia-flow

Orquesta agentes de IA contra repos y GitHub Projects. Monorepo Bun: un runner
headless (`apps/runner-v2`) sobre los paquetes del engine (`packages/agent-engine/*`,
`provider-anthropic`, `github/*`, `local/*`, `telemetry`), una SPA Vue 3 y su visor
Electron.

La guía profunda de arquitectura está en [CLAUDE.md](./CLAUDE.md); esto es lo
mínimo para levantarlo.

## Requisitos

- **[Bun](https://bun.sh)** — el único package manager y runtime del repo (nada de npm/pnpm/yarn).
- **git** — `@ia-flow/workspace` clona, crea worktrees y pushea.
- **Una credencial de Anthropic** — ver abajo.
- Una GitHub App (o un token) para leer y escribir el board y los repos.

## Credenciales de Anthropic — obligatorias para usar la API

**Para usar el provider de Anthropic tenés que definir tu propia API key de
Anthropic.** ia-flow no incluye ni provee credenciales: llama a la API de
Anthropic con las tuyas, y el consumo se factura a tu cuenta bajo los términos
de Anthropic.

El runner lee `ANTHROPIC_API_KEY` (otra variable si `runner.yaml` la nombra con
`apiKeyEnv`). `@ia-flow/provider-anthropic` también acepta
`CLAUDE_CODE_OAUTH_TOKEN`, que gana si está seteado.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Dejalas en el `.env` de `apps/runner-v2` (gitignoreado) o en el entorno del
contenedor. **Nunca las commitees.**

## Arranque

```bash
bun install          # desde la raíz: instala todos los workspaces
bun run runner       # runner-v2: verifica GitHub, carga y valida la definición
bun run runner:serve # runner-v2: servidor de webhooks
bun run dev          # la web (5173)
```

La configuración del runner (`.config/`, variables de entorno) está en
[apps/runner-v2/README.md](./apps/runner-v2/README.md).

## Layout

```
apps/runner-v2/     Runner headless: definición en YAML (.config/), ejecuciones en SQLite
apps/web/           SPA Vue 3 + Vite + Pinia
apps/desktop/       Visor Electron de la SPA
packages/agent-engine/  core, definitions, datasources/{sqlite,yaml}
packages/github/        auth, api, webhook, tools
packages/local/         fs, shell, workspace
packages/               provider-anthropic, telemetry, shared, figma-auth
```

Los paquetes del engine son source-only (sin build ni `dist/`): se consumen con
`workspace:*` y cada uno trae su `README.md` / `CLAUDE.md`.

## Comandos

```bash
bun run test         # todos los workspaces
bun run typecheck    # todos los workspaces
bun run test:<pkg>   # uno solo, p.ej. test:agent-engine o test:runner-v2
bun run lint         # biome
bun run check        # biome + typecheck + test  ← correlo antes de pushear
```

## Licencia

[MIT](./LICENSE). ia-flow no incluye credenciales ni acceso a modelos: usar el
provider de Anthropic requiere tu propia API key y queda sujeto a los términos
de servicio de Anthropic.
