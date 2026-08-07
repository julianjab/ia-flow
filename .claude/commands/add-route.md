---
description: Scaffold de un nuevo router Hono en apps/server + mount en index.ts
argument-hint: <nombre-recurso>
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(bun *)
model: sonnet
---

Genera un nuevo router siguiendo el patrón existente.

Nombre del recurso: `$1` (usa kebab-case; si viene en camelCase o snake_case, normalízalo).

## Pasos

1. Lee `apps/server/src/routes/providers.js` (o el más simple que exista) para copiar el patrón: `createXRouter()`, `new Hono()`, exports, uso de `getDb()`.
2. Crea `apps/server/src/routes/$1.ts` con:
   - `import { Hono } from 'hono'`
   - `import { createLogger } from '../logger.js'`
   - `export function create<PascalCase>Router() { const app = new Hono(); ... return app }`
   - Al menos un handler GET `/` como stub.
3. Edita `apps/server/src/index.ts`:
   - Añade `import { create<Pascal>Router } from './routes/$1.js'`
   - Añade `app.route('/api/$1', create<Pascal>Router())` en la sección de mounts.
4. Reporta el archivo creado y línea del mount en index.ts.

**No** crees tests genéricos — deja que el desarrollador los escriba con los casos reales.
