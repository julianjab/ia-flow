# packages/shared — Zod schemas + types

**Source-only** (no build step). Consumido por `apps/server` y `apps/web` como `@ia-flow/shared`.

## Contenido

- `src/schemas.ts` — TODOS los Zod schemas que cruzan la red o persisten en DB.
- `src/types.ts` — Tipos derivados con `z.infer<typeof X>`. Nombres sin sufijo `Schema`.
- `src/template-variables.ts` — Registry global de variables de template disponibles a los agentes.
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

## Reglas

- **No runtime deps** salvo Zod. Nada de axios, fs, path, bun:*, browser APIs. Debe correr en ambos entornos.
- **Cualquier cambio a schemas** requiere pasar por el subagent `shared-schema-guardian` antes de PR (audita usos en server + web).
- **Rompiendo compat:** si cambias un schema existente, busca todos los `.parse()` y ajústalos en la misma pasada.
- **Tests:** `schemas.test.ts` cubre round-trips y edge cases. Añade caso cuando agregues schema.

## Comando

```bash
bun run test           # vitest run
```
