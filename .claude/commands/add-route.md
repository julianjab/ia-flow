---
description: Scaffold de un nuevo router Hono en apps/server + mount en index.ts
argument-hint: <nombre-recurso>
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(bun *)
model: sonnet
---

Genera un nuevo router siguiendo el patrón existente.

Nombre del recurso: `$1` (usa kebab-case; si viene en camelCase o snake_case, normalízalo).

Recuerda que `routes/` es **el borde HTTP**: valida con Zod, delega, mapea el resultado a un status
code. Nada de SQL ni de reglas de negocio adentro, y **nunca** importa `infrastructure/` ni
`adapters/` directo — las dependencias se toman de `composition/container.js`.

## Pasos

1. Lee `apps/server/src/routes/statuses.ts` (CRUD scopeado por proyecto, consume el container) para copiar el patrón: `createXRouter()`, `new Hono()`, validación, forma de las respuestas de error.
2. Crea `apps/server/src/routes/$1.ts` con:
   - `import { Hono } from 'hono'`
   - `import { createLogger } from '../logger.js'` → `const log = createLogger('routes:$1')`
   - Los repos/use-cases que necesite, importados de `../composition/container.js`
   - `export function create<PascalCase>Router() { const router = new Hono(); ... return router }`
   - Al menos un handler GET `/` como stub.
   - Si el recurso recibe payload, valida con `safeParse` de un schema de `@ia-flow/shared`
     (defínelo ahí si no existe) y responde `400` con `{ error, issues }` cuando falle.
3. Edita `apps/server/src/entry/server.ts`:
   - Añade `import { create<Pascal>Router } from './routes/$1.js'`
   - Añade `app.route('/api/$1', create<Pascal>Router())` en la sección de mounts.
4. Reporta el archivo creado y línea del mount en index.ts.

**No** crees tests genéricos — deja que el desarrollador los escriba con los casos reales.
