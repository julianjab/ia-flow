# packages/shared — Zod schemas + types

**Source-only** (no build step). Consumido por `apps/runner-v2` y `apps/web` como `@ia-flow/shared`.

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
  del runner (viven en `apps/runner-v2/src`), ni nada con I/O.
- Si dudas: si al borrar `apps/web` el símbolo sigue teniendo sentido para el server **y**
  viceversa, pertenece aquí. Si no, vive en la app.
- **Excepción deliberada — `cache.ts`:** no es parte del contrato de red, es una utilidad
  transversal (sin estado de dominio, sin I/O, sin dependencia de schemas). Vive acá porque
  tanto `apps/runner-v2` como cualquier `packages/*` la pueden necesitar, y `packages/shared` es el
  único paquete fuente que todos ya importan — no porque encaje en "contract-only". No agregues
  más utilidades genéricas acá sin pensar si de verdad no encajan mejor en el paquete que las usa.

## Cache — `@memoize`

`src/cache.ts` expone un decorator de método para memoizar resultados por instancia, en vez de
armar a mano un `Map<key, {value, at}>` junto a la clase.

```ts
import { memoize, invalidateMemoized, peekMemoized } from '@ia-flow/shared'

class BoardReader {
  @memoize({ ttlMs: 5 * 60_000, key: () => 'meta', bypass: (opts) => opts?.refresh === true })
  private loadMeta(opts?: { refresh?: boolean }) { /* ... */ }
}
```

- **Storage por instancia** (`WeakMap` por `this`): dos instancias no comparten cache, y muere con
  la instancia.
- **`ttlMs`** (default: hasta invalidar), **`key`** (default: `JSON.stringify(args)`; una key
  constante cuando un flag tipo `refresh` NO debe partir el cache), **`bypass`** (saltar la lectura
  sin dejar de repoblar).
- **Las promesas en vuelo se comparten**: dos llamadas concurrentes dedupean sobre la misma. Un
  `reject` no se cachea.
- **`invalidateMemoized(instance, methodName?)`** dropea un método o la instancia entera;
  **`peekMemoized(instance, methodName, key)`** lee sync una entrada ya resuelta.
- Requiere `experimentalDecorators: true` en el `tsconfig.json` del paquete que lo usa, y que Bun
  corra con `--cwd` de ese paquete: Bun toma la opción del tsconfig del directorio desde el que
  corre y sólo aplica la forma legada del decorator, no la TC39.

## Reglas

- **No runtime deps** salvo Zod. Nada de axios, fs, path, bun:*, browser APIs. Debe correr en ambos entornos.
- **Cualquier cambio a schemas** requiere pasar por el subagent `shared-schema-guardian` antes de PR (audita usos en server + web).
- **Rompiendo compat:** si cambias un schema existente, busca todos los `.parse()` y ajústalos en la misma pasada.
- **Tests:** `schemas.test.ts` cubre round-trips y edge cases. Añade caso cuando agregues schema.

## Comando

```bash
bun run test           # vitest run
```
