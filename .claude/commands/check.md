---
description: Corre biome + typecheck + tests para los workspaces afectados (o todos con --all)
argument-hint: [--all]
allowed-tools: Bash(bun *), Bash(bunx *), Bash(git status:*), Bash(git diff:*), Read
model: sonnet
---

Ejecuta el gate de calidad pre-push.

Argumento: `$1` (vacío o `--all`).

## Pasos

1. Si `$1` NO es `--all`:
   - `git status --porcelain` para detectar workspaces tocados.
   - Determina qué correr: si hay cambios en `apps/server/**` corre server; en `apps/web/**` corre web; en `packages/shared/**` corre shared (afecta a los otros dos — corre los tres).
2. Si `$1` == `--all` o hay cambios en `packages/shared/`, corre todo:
   ```
   bunx biome check .
   bun run typecheck
   bun run test
   ```
3. Reporta resultado con ✅/❌ por paso.

Si falla algo, NO intentes arreglar automáticamente — reporta al usuario con `file:line`.
