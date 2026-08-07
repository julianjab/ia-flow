# apps/web — Vue 3 SPA

Vite + Vue Router + Pinia. Puerto **5173**. Proxy a `http://localhost:3001` para `/api` y `/ws`.

## Capas

```
src/
├── main.ts             Bootstrap Vue + Pinia + Router
├── router/             Vue Router (SPA)
├── views/              Páginas montadas por el router
├── components/         Componentes reutilizables
├── stores/             Pinia stores (state por dominio)
└── api/                Wrappers axios — 1 archivo por dominio, funciones simples
```

## Reglas

- **Composition API + `<script setup lang="ts">`** — no Options API en código nuevo.
- **Stores Pinia:** `defineStore('name', () => { ... })` (composition style).
- **API calls:** siempre a través de `src/api/*.ts`, no axios inline en componentes.
- **Tipos de red:** importa de `@ia-flow/shared` y valida con `.parse()` los responses críticos.
- **Componentes grandes:** si un `.vue` supera ~500 líneas, extrae subcomponentes. `SettingsView.vue` (~2k líneas) es deuda técnica conocida — cuando la toques, extrae por sección.
- **Estilos:** scoped por componente. Sin CSS global nuevo.
- **Tests:** `foo.vue` + `foo.spec.ts` (Vitest + @vue/test-utils + happy-dom).

## Comandos

```bash
bun run dev            # vite dev :5173
bun run test           # vitest run
bun run typecheck      # vue-tsc --noEmit
bun run build          # vue-tsc + vite build
```

## Al terminar cambios

Corre `/check` o directo: `bun run typecheck && bun run test`. Subagent: `web-verifier`.
