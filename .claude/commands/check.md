---
description: Corre biome + fronteras + typecheck + tests de los workspaces afectados (o todos con --all)
argument-hint: [--all]
allowed-tools: Bash(bun *), Bash(bunx *), Bash(git status:*), Bash(git diff:*), Bash(grep *), Read
model: sonnet
---

Ejecuta el gate de calidad pre-push.

Argumento: `$1` (vacío o `--all`).

## Pasos

1. Si `$1` == `--all`, o hay cambios en `packages/shared/**`, `package.json`, `bun.lock`,
   `tsconfig.base.json`, `biome.json` o `.dependency-cruiser.cjs`: corré el gate completo y
   terminá con el paso 4.
   ```
   bun run check        # biome check . + lint:boundaries + typecheck + test
   ```
2. Si no, `git status --porcelain` (y `git diff --name-only main...HEAD` si la rama tiene
   commits) para ver qué workspaces se tocaron, y armá la lista:
   - `apps/runner-v2/**` → `runner-v2`
   - `apps/web/**` → `web`
   - `apps/desktop/**` → `desktop`
   - `packages/<…>/**` → el `<pkg>` cuyo script es `typecheck:<pkg>` / `test:<pkg>` en el
     `package.json` raíz y apunta a esa carpeta (p. ej. `packages/github/tools` → `github-tools`,
     `packages/agent-engine/core` → `agent-engine`). Un paquete es source-only: sumá también los
     workspaces que lo importan
     (`grep -rl --include=package.json --exclude-dir=node_modules '"@ia-flow/<nombre>"' apps packages`),
     porque un cambio de API rompe ahí.
3. Corré, en este orden:
   ```
   bunx biome check .
   bun run lint:boundaries          # siempre, aunque sólo se haya tocado la web
   bun run typecheck:<pkg>          # por cada workspace de la lista
   bun run test:<pkg>               # por cada workspace de la lista
   ```
4. Reportá ✅/❌ por paso y por workspace.

Si algo falla, NO lo arregles automáticamente: reportá al usuario con `file:line` (y, para
`lint:boundaries`, el `comment` de la regla que saltó).
