# apps/web — Vue 3 SPA

Vite + Vue Router + Pinia. Puerto **5173** por default, configurable con `IA_FLOW_WEB_PORT`.
Proxy de `/api` y `/ws` al server (`IA_FLOW_SERVER_PORT`, default 3001; `VITE_API_TARGET`
sobreescribe el destino completo). Ver la tabla de puertos en el [CLAUDE.md raíz](@CLAUDE.md).

## Arquitectura — Feature-sliced

El código se agrupa por **dominio de negocio**, no por tipo de archivo. Una feature es una
carpeta autocontenida: su HTTP, su estado y sus componentes viven juntos.

```
src/
├── main.ts             Bootstrap Vue + Pinia + Router
├── router/             Vue Router (SPA)
├── views/              Páginas del router. SOLO composición — sin fetch ni lógica de negocio.
│
├── features/<dominio>/ La unidad real de la app. Ej: agents, tasks, tunnel, providers, repos…
│   ├── api.ts            Llamadas HTTP del dominio + `.parse()` de la respuesta
│   ├── store.ts          Pinia composition store (sólo si el estado se comparte/sobrevive nav)
│   └── *.vue             Componentes del dominio (+ subcarpetas: tabs/, sources/, providerForms/)
│
├── ui/                 Primitivas sin dominio (AutocompleteSelect, ConfirmDialog, Toast…)
├── components/         Widgets compartidos por 2+ features (si sólo lo usa una, va en su feature)
├── composables/        Lógica reactiva transversal (useServerEvents, useKeyboardNav)
├── stores/             Sólo estado global de app (toast). El estado de dominio va en su feature.
└── styles/             theme.css — tokens y primitivas globales
```

### Reglas de frontera

| Capa | Importa | NUNCA importa |
| --- | --- | --- |
| `ui/` | nada del negocio | `features/**`, `api.ts`, stores |
| `features/a/` | `ui/`, `composables/`, `components/`, `@ia-flow/shared` | **`features/b/`** |
| `views/` | features, ui, composables | axios/fetch directo |
| `*.vue` | su `api.ts` / store | axios o `fetch` inline |

- **Feature → feature está prohibido.** Si dos features necesitan lo mismo: si es visual sube a
  `ui/`, si es reactivo sube a `composables/`, si es un tipo sube a `@ia-flow/shared`.
- **Feature nueva** = carpeta nueva en `features/` con su `api.ts`. No agregues endpoints de un
  dominio al `api.ts` de otro.
- **`store.ts` sólo cuando hace falta.** Si el estado vive y muere dentro de un componente, usa
  `ref`. Un store por dominio, nunca un store global de todo.
- **Validación en `api.ts`, no en el componente.** `Schema.parse(res.data)` ocurre en la capa de
  red; el componente recibe datos ya tipados.

## Reglas

- **Antes de crear o modificar UI, lee [DESIGN_SYSTEM.md](@apps/web/DESIGN_SYSTEM.md) y `src/styles/theme.css`.** La app es una consola dark v3: paleta ANSI-16, JetBrains Mono, radio 0, filas de 22px. Cualquier `background: #fff`, radio > 0, sombra decorativa o color hex hardcoded rompe el sistema. Reutiliza `.panel`, `.panel__header`, `.uc-label`, `.kbd`, `.live-dot` antes de escribir CSS nuevo.
- **Composition API + `<script setup lang="ts">`** — no Options API en código nuevo.
- **Stores Pinia:** `defineStore('name', () => { ... })` (composition style), en `features/<dominio>/store.ts`.
- **API calls:** siempre a través de `features/<dominio>/api.ts`, no axios inline en componentes.
- **Tipos de red:** importa de `@ia-flow/shared` y valida con `.parse()` los responses críticos.
- **Componentes grandes:** si un `.vue` supera ~300 líneas, extrae subcomponentes **dentro de su
  feature** (patrón ya usado: `features/projects/tabs/`, `features/agents/providerForms/`).
- **Estilos:** scoped por componente, **usando variables de `theme.css`** (`var(--fg)`, `var(--panel)`, etc.). Sin CSS global nuevo salvo tokens en `theme.css`. Sin hex hardcoded.
- **Sub-navegación:** vive en el sidebar (`SettingsSidebar.vue`, prop `children`). No agregues tab strips arriba del contenido.
- **Tests:** `foo.vue` + `test/foo.test.ts` (subcarpeta `test/` junto al archivo, no colocado en el mismo nivel). Vitest + @vue/test-utils + happy-dom.

## Checklist obligatorio antes de terminar cambios de UI

1. [ ] Leí `DESIGN_SYSTEM.md` y `theme.css`.
2. [ ] Cero hex hardcoded (`grep -n '#[0-9a-fA-F]\{3,6\}' <file>` sale vacío).
3. [ ] Cero `border-radius > 0` (el reset global mete `!important`, pero no lo pelees).
4. [ ] Reutilicé primitivas antes de inventar clases (`.panel`, `.kbd`, `.select-row`, `.live-dot`, `.uc-label`).
5. [ ] Filas de tabla/lista miden 22px o múltiplo (`var(--row-h)`).
6. [ ] Contraste texto/fondo ≥ 4.5:1 en la paleta oscura.
7. [ ] Cero imports cruzados entre features
   (`grep -rn "from '@/features/" src/features | grep -v "/$(dirname)"` — cada hit debe ser a su propia feature).
8. [ ] Cero `axios.`/`fetch(` fuera de `features/*/api.ts`.

## Comandos

```bash
bun run dev            # vite dev :5173 (o IA_FLOW_WEB_PORT)
bun run test           # vitest run
bun run typecheck      # vue-tsc --noEmit
bun run build          # vue-tsc + vite build
```

## Al terminar cambios

Corre `/check` o directo: `bun run typecheck && bun run test`. Subagent: `web-verifier`.
