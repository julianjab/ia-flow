# packages/shared — Zod schemas + types

**Source-only** (no build step). Consumido por `apps/server` y `apps/web` como `@ia-flow/shared`.

## Contenido

- `src/schemas.ts` — TODOS los Zod schemas que cruzan la red o persisten en DB.
- `src/types.ts` — Tipos derivados con `z.infer<typeof X>`. Nombres sin sufijo `Schema`.
- `src/template-variables.ts` — Registry global de variables de template disponibles a los agentes.
- `src/index.ts` — Re-export barrel.

## Reglas

- **No runtime deps** salvo Zod. Nada de axios, fs, path, bun:*, browser APIs. Debe correr en ambos entornos.
- **Cualquier cambio a schemas** requiere pasar por el subagent `shared-schema-guardian` antes de PR (audita usos en server + web).
- **Rompiendo compat:** si cambias un schema existente, busca todos los `.parse()` y ajústalos en la misma pasada.
- **Tests:** `schemas.test.ts` cubre round-trips y edge cases. Añade caso cuando agregues schema.

## Comando

```bash
bun run test           # vitest run
```
