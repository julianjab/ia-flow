# packages/shared — Zod schemas + types

**Source-only** (no build step). Consumido por `apps/server` y `apps/web` como `@ia-flow/shared`.

## Contenido

- `src/schemas.ts` — TODOS los Zod schemas que cruzan la red o persisten en DB.
- `src/types.ts` — Tipos derivados con `z.infer<typeof X>`. Nombres sin sufijo `Schema`.
- `src/template-variables.ts` — Registry global de variables de template disponibles a los agentes.
- `src/cache.ts` — decorator `@memoize` (cache genérico por método/instancia). Ver más abajo.
- `src/index.ts` — Re-export barrel.

## Rol arquitectónico

Es el **contrato**, no una librería de utilidades. Su única razón de existir: que server y web
no puedan discrepar sobre la forma de los datos que cruzan la red.

- Va acá lo que **ambos lados** necesitan: schemas de request/response, tipos derivados,
  enums/constantes del contrato, y el registry de variables de template.
- **No** va acá: lógica de negocio, helpers de formato usados por un solo lado, tipos internos
  del server (los ports viven en `apps/server/src/domain/ports/`), ni nada con I/O.
- Si dudas: si al borrar `apps/web` el símbolo sigue teniendo sentido para el server **y**
  viceversa, pertenece aquí. Si no, vive en la app.
- **Excepción deliberada — `cache.ts`:** no es parte del contrato de red, es una utilidad
  transversal (sin estado de dominio, sin I/O, sin dependencia de schemas). Vive acá porque
  tanto `apps/server` como cualquier `packages/*` la pueden necesitar, y `packages/shared` es el
  único paquete fuente que todos ya importan — no porque encaje en "contract-only". No agregues
  más utilidades genéricas acá sin pensar si de verdad no encajan mejor en el paquete que las usa.

## Cache — `@memoize`

Ver `CLAUDE.md` raíz del repo (sección "Cache transversal — `@memoize`") para la guía completa
de uso. Resumen: decorator de método que memoiza por `(instancia, key(args))`, con `ttlMs`,
`key` y `bypass` configurables, más `invalidateMemoized`/`peekMemoized` para invalidar o leer
sync. Requiere `experimentalDecorators: true` en el `tsconfig.json` del paquete que lo usa —
Bun sólo aplica el reemplazo del decorator en su forma legada, no la TC39 (stage-3).

## Reglas

- **No runtime deps** salvo Zod. Nada de axios, fs, path, bun:*, browser APIs. Debe correr en ambos entornos.
- **Cualquier cambio a schemas** requiere pasar por el subagent `shared-schema-guardian` antes de PR (audita usos en server + web).
- **Rompiendo compat:** si cambias un schema existente, busca todos los `.parse()` y ajústalos en la misma pasada.
- **Tests:** `schemas.test.ts` cubre round-trips y edge cases. Añade caso cuando agregues schema.

## Comando

```bash
bun run test           # vitest run
```
