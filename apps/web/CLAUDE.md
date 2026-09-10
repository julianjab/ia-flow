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

- **Antes de crear o modificar UI, lee [DESIGN_SYSTEM.md](@apps/web/DESIGN_SYSTEM.md) y `src/styles/theme.css`.** Ese archivo es la definición vigente y trae su propio checklist — el de acá abajo no lo reemplaza. La app es una consola oscura **v4**: teal-sage sobre neutros cálidos, tres roles de IBM Plex (Condensed / Sans / Mono), radio por token (`--radius` / `--radius-sm`), filas de `--row-h` y **blanco táctil de `--tap-h` en todo lo que se toca**. Cualquier hex hardcodeado, radio a mano o sombra decorativa rompe el sistema. Reutiliza `.panel`, `.uc-label`, `.btn`, `.kbd`, `ui/form-fields.css` antes de escribir CSS nuevo.
- **Un formulario de configuración tiene una anatomía definida** — las cinco franjas, las tres formas y el test para plegar un bloque, en «Anatomía de un formulario de configuración» de `DESIGN_SYSTEM.md`. Un formulario nuevo no inventa su propio kit de campo ni su propio pie (R18, R19).
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

Es el resumen; el completo, con las reglas R1–R26, está al final de `DESIGN_SYSTEM.md`.

1. [ ] Leí `DESIGN_SYSTEM.md` y `theme.css`.
2. [ ] Cero hex hardcoded (`grep -n '#[0-9a-fA-F]\{3,6\}' <file>` sale vacío) y cero familia de fuente escrita a mano.
3. [ ] Radios por token (`--radius` / `--radius-sm`); ningún `5px`/`6px`/`8px` a mano.
4. [ ] Reutilicé primitivas antes de inventar clases (`.panel`, `.btn`, `.kbd`, `.uc-label`, `ui/form-fields.css`, `ui/FormFooter.vue`).
5. [ ] Las filas miden `--row-h` o un múltiplo, y **todo lo presionable mide `--tap-h`** (R1).
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
