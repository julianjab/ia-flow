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

- **Antes de crear o modificar UI, lee [DESIGN_SYSTEM.md](@apps/web/DESIGN_SYSTEM.md) y `src/styles/theme.css`.** La app es una consola dark v3: paleta ANSI-16, JetBrains Mono, radio 0, filas de 22px. Cualquier `background: #fff`, radio > 0, sombra decorativa o color hex hardcoded rompe el sistema. Reutiliza `.panel`, `.panel__header`, `.uc-label`, `.kbd`, `.live-dot` antes de escribir CSS nuevo.
- **Composition API + `<script setup lang="ts">`** — no Options API en código nuevo.
- **Stores Pinia:** `defineStore('name', () => { ... })` (composition style).
- **API calls:** siempre a través de `src/api/*.ts`, no axios inline en componentes.
- **Tipos de red:** importa de `@ia-flow/shared` y valida con `.parse()` los responses críticos.
- **Componentes grandes:** si un `.vue` supera ~500 líneas, extrae subcomponentes. `SettingsView.vue` (~2k líneas) es deuda técnica conocida — cuando la toques, extrae por sección.
- **Estilos:** scoped por componente, **usando variables de `theme.css`** (`var(--fg)`, `var(--panel)`, etc.). Sin CSS global nuevo salvo tokens en `theme.css`. Sin hex hardcoded.
- **Sub-navegación:** vive en el sidebar (`SettingsSidebar.vue`, prop `children`). No agregues tab strips arriba del contenido.
- **Tests:** `foo.vue` + `foo.spec.ts` (Vitest + @vue/test-utils + happy-dom).

## Checklist obligatorio antes de terminar cambios de UI

1. [ ] Leí `DESIGN_SYSTEM.md` y `theme.css`.
2. [ ] Cero hex hardcoded (`grep -n '#[0-9a-fA-F]\{3,6\}' <file>` sale vacío).
3. [ ] Cero `border-radius > 0` (el reset global mete `!important`, pero no lo pelees).
4. [ ] Reutilicé primitivas antes de inventar clases (`.panel`, `.kbd`, `.select-row`, `.live-dot`, `.uc-label`).
5. [ ] Filas de tabla/lista miden 22px o múltiplo (`var(--row-h)`).
6. [ ] Contraste texto/fondo ≥ 4.5:1 en la paleta oscura.

## Comandos

```bash
bun run dev            # vite dev :5173
bun run test           # vitest run
bun run typecheck      # vue-tsc --noEmit
bun run build          # vue-tsc + vite build
```

## Al terminar cambios

Corre `/check` o directo: `bun run typecheck && bun run test`. Subagent: `web-verifier`.
