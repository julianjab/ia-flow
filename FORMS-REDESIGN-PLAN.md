# Rediseño de formularios · plan y estado

> **Archivo de trabajo.** Vive sólo en `feat/forms-redesign` para que el plan sobreviva a un
> reinicio y a un cambio de sesión. **Se borra en el último commit, antes de abrir el PR.**

Fuente: los dos canvas de diseño del turno 10 —`Formularios.dc.html` y
`Pantallas de configuración.dc.html`— leídos contra `main` y verificados archivo por archivo.

Modo de trabajo acordado con el usuario: **un único PR, en este worktree
(`/tmp/claude-worktrees/ia-flow/forms-redesign`), con commits granulares por fase.**

---

## Estado

| Fase | Qué | Estado |
| --- | --- | --- |
| 0 | Contrato en `DESIGN_SYSTEM.md` | ✅ `e234f24ce` |
| 1 | `FormFooter` + `.ff-band` / `.ff-col` + slot `lead` en `StickyActionBar` | ✅ `b126e0295` + `26367c0b7` (test) |
| 2 | **Agente** | ⏳ **acá quedó** — leyendo `AgentEditorModal.vue` |
| 3 | Provider | pendiente |
| 4 | System prompt | pendiente |
| 5 | Pipeline / regla | pendiente |
| 6 | Acción | pendiente |
| 7 | Tool | pendiente |
| 8 | Entorno | pendiente |
| 9 | Cierre: `apps/web/CLAUDE.md` + borrar este archivo | pendiente |

`bun install` ya corrió en el worktree. `bun run typecheck` y el test de `FormFooter` pasan.

---

## Lo verificado contra `main` (no hace falta re-auditar)

| Afirmación del canvas | Verificado |
| --- | --- |
| `CollapsibleSection` huérfano | sí — sólo lo importa su propio test |
| Kit local (`class="label"` / `.input` / `.field-hint`) | 6 archivos: `agents/ToolsEditor`, `agents/AgentEditorModal`, `agents/AgentDefinitionSection`, `agents/SystemPromptsSection`, `prompts/PromptField`, `rules/RuleEditorModal` |
| Kit del sistema (`form-fields.css`) | 21 componentes lo importan |
| Cuatro formas de guardar | `StickyActionBar` (Entorno, Ejecuciones), `.save-button` (`ProvidersSection`, `EntornoSection`), pie de card (`SystemPromptForm`), pie inline (Tools, Acciones) |
| `.ts-field` / `.ts-hint` | sólo `features/tools/ToolsSection.vue` |
| Rail de 6 secciones ya en el editor de agentes | sí, `AgentEditorModal.vue:528`; bajo 768px se vuelve tira horizontal (`:987`) |
| `EntornoSection` "v3 entero" en la tabla de deuda | **vencido** — ya usa `ff-*` + `StickyActionBar`. Corregido en fase 0 |
| `FullScreen` en uso | `RepoConfigModal`, `ProjectCreateModal` |

Las dos primitivas clave ya tenían lo que el diseño pide: `CollapsibleSection` tiene prop
`summary` (R22) y `forceOpen`; `StickyActionBar` tiene `note` / `noteIsError`.
**No hay design system nuevo que construir — hay que cablearlo.**

---

## Lo que ya está hecho, en detalle

### Fase 0 — `apps/web/DESIGN_SYSTEM.md`

- Sección nueva **«Anatomía de un formulario de configuración»** (entre «Botones» y «Campos —
  deuda conocida»): las cinco franjas y su orden fijo, las tres formas (form libre / lista /
  secciones), el test de las tres condiciones, las cinco ranuras de texto y los tres regímenes
  de ancho.
- **R18–R26** al final de «Reglas transversales» (heading renombrado a `R1 a R26`).
- `ui/FormFooter.vue` agregado a la lista de primitivas.
- Cinco ítems nuevos al checklist.
- Tabla de deuda corregida: fuera `EntornoSection` (es el arquetipo «lista»), dentro el kit local
  de campo ×6, `.ts-field`, las clases sin declarar de `AnthropicApiSettingsForm` y las cuatro
  formas de guardar.

### Fase 1 — `apps/web/src/ui/`

- **`FormFooter.vue`** (nuevo). Props: `note`, `noteIsError`, `saveDisabled`, `saveLabel`,
  `deleteLabel`, `readonly`, `sticky`. Emits: `save` / `cancel` / `delete`.
  `Eliminar` a la izquierda separado por el ancho entero; `readonly` deja un solo `Cerrar`.
  `sticky` (default) compone `StickyActionBar`; `:sticky="false"` para el slot `footer` de
  `FullScreen`, que ya trae su propio pie que no scrollea.
- **`StickyActionBar.vue`**: slot `lead` (izquierda del todo) + `.sab__spacer` para cuando no hay
  `note`. Bajo 640px el `lead` baja a su propia línea.
- **`form-fields.css`**: `.ff-col` (tope de `46rem`, R25) y `.ff-band` (el ritmo entre franjas +
  el separador, R19). Una franja **no** es una caja con título.

---

## Fases pendientes

Orden de PRs/commits, y qué toca cada uno. Cada fase termina con `bun run typecheck` +
`bunx vitest run` de lo tocado; código y tests en **commits separados** (el pre-commit hook los
rechaza mezclados) y cada `git add`/`git commit` en su propia llamada a Bash.

### Fase 2 · Agente (la más grande)

Archivos: `features/agents/AgentEditorModal.vue` (1028 líneas), `AgentDefinitionSection.vue`,
`SystemPromptsSection.vue`, `ToolsEditor.vue`.

- **El rail se queda sobre 1100px** — ya es el índice al costado y cumple R22/R24 mejor que un
  chevron. Es la implementación de referencia del régimen de 1100+.
- **Bajo 1100px, las mismas seis secciones como franjas con `CollapsibleSection`.** Hoy el rail se
  vuelve una tira horizontal de pestañas con scroll lateral (`:987`) — viola R2 y R14.
- **`Provider` sale de «Definición»** y baja a «cómo corre», con su `providerConfig` por agente
  adentro. Definición queda con lo que identifica: ID y activo. Es el único movimiento de campos.
- **La checklist del `summary-rail` baja al `note` del pie** bajo 768px: «falta el prompt» al lado
  de un `Guardar` apagado es exactamente lo que ese panel dice.
- **Los tres dialectos de label** del editor (`.label`, `.field-label`, `.uc-label`) → `.uc-label`,
  y los campos → `ff-row` / `ff-field` / `ff-hint`.
- Pie → `FormFooter` (hoy está en `.page-head`, arriba: `AgentEditorModal.vue:500-519`).
- **Cambio de comportamiento aceptado por el usuario:** hoy abre con todo desplegado; con esto
  cuatro bloques arrancan cerrados.

### Fase 3 · Provider

Archivos: `features/providers/ProvidersSection.vue`, `AnthropicApiSettingsForm.vue`.

- **Un provider por vez**, elegido en una fila de chips arriba, en vez de los tres apilados con un
  `Guardar providers` que promete más de lo que uno vino a cambiar.
- `.field` / `.field-block` (clases que **nadie declara**) → `ff-row` / `ff-field`: hoy MCP servers
  y Stream quedan sin caja al lado de siete campos que sí la tienen.
- De ocho campos planos a tres visibles (modelo, effort, stream); los cinco numéricos a `Límites` y
  `Thinking` plegados, con su valor efectivo en el `summary` (R22).
- El error de validación va **al campo** (`.ff-error` en el lugar del hint), no a un cartel bajo la
  sección.
- `.save-button` al final del documento → `FormFooter` (R3).

### Fase 4 · System prompt

Archivos: `features/project-config/SystemPromptForm.vue`, `GlobalSystemPromptsSection.vue`,
`features/agents/SystemPromptsSection.vue`.

- **R23 de una: un solo componente para los tres ámbitos**, con el heredado en `fieldset disabled`
  (`SystemPromptForm` ya lo hace bien) y `FormFooter :readonly`.
- Dentro del agente, tocar un chip abre **este mismo formulario en lectura**. Hoy el texto sólo
  existe como `title=` — hover como único camino (R7).
- El **id va como hint del nombre**, no como campo: se deriva y no se edita.
- El texto ocupa lo que sobra (hoy: cuatro filas fijas en una card con padding de 1rem, radio 8px
  y anillo de foco azul fuera de paleta).

### Fase 5 · Pipeline / regla

Archivos: `features/rules/RuleEditorModal.vue` (687 líneas), `RuleScopeEditor.vue`,
`ActionsEditor.vue`.

- Los **dos kits chocan dentro del mismo modal**: los cinco campos de arriba son `.label`/`.input`
  local y el bloque de ámbito de abajo es `uc-label`/`ff-field`. Dos alturas de campo y dos
  tipografías de label a diez píxeles de distancia.
- **Nombre antes que Id** (el nombre es lo que se lee en la lista; el id se deriva).
- Evento + acciones = franja 2. Ámbito → sección **abierta**; Cron y Descripción, cerradas.
- **`Estado` deja de ser un campo**: es el badge del chrome, como en la fila de la lista.
- `RuleSentence` es el candidato natural al `summary` del encabezado colapsado (R22).

### Fase 6 · Acción

Archivos: `features/rules/NamedActionsSection.vue`, `actionForms/` (×6), `ActionWhenEditor.vue`.

- Los seis forms **ya están en el kit** — es la familia más consistente de la app.
- Único cambio real: **`Timeout` y `Cuándo` salen del cuerpo del tipo** a dos secciones cerradas al
  pie, así los seis quedan con la misma silueta.
- **`Nombre` primero y deja de ser «Opcional»**: es lo que la fila de la lista muestra.
- El alta inline pasa a `FullScreen` bajo 768px: un formulario de nueve campos abierto en medio de
  una lista deja al ítem que se crea sin contexto arriba ni abajo.

### Fase 7 · Tool

Archivo: `features/tools/ToolsSection.vue` (634 líneas).

- `.ts-field` → `.ff-field` y `.ts-hint` → `.ff-hint`. Es la última copia de la caja del campo:
  hoy son campos de **25px** (`--row-h`) donde se escribe.
- **La descripción pasa a textarea de tres líneas**: es lo único que el modelo lee para decidir
  cuándo usar la tool, y hoy se escribe en un campo de una línea.
- Los parámetros son **franja 2, no una sección**.
- Las tres listas con `ScopeGroup` y el `InlineEdit` de la descripción **se quedan**: funcionan.

### Fase 8 · Entorno

Archivo: `features/env-vars/EntornoSection.vue`.

- Ya es el arquetipo. Único pendiente real: **un `listo`** que devuelva el grupo a lectura — hoy se
  entra en modo edición por grupo y no hay forma de salir sin guardar o recargar.
- Su `.save-button` propio → `FormFooter`.

### Fase 9 · Cierre

- **`apps/web/CLAUDE.md` está vencido y contradice al design system**: dice «consola dark v3,
  paleta ANSI-16, JetBrains Mono, radio 0, filas de 22px» y su checklist pide «cero
  `border-radius > 0`», mientras `DESIGN_SYSTEM.md` es v4 (teal-sage, IBM Plex, `--radius`).
  Alinearlo y apuntar al checklist del DS.
- **Borrar este archivo** y abrir el PR.

---

## Verificación de cierre

```bash
bun run check                      # biome + typecheck + tests, desde la raíz del worktree
grep -rl 'class="label"' apps/web/src      # debe salir vacío
grep -rl 'ts-field\|ts-hint' apps/web/src  # debe salir vacío
grep -rl 'save-button' apps/web/src        # debe salir vacío
```

Subagentes: `web-verifier` al terminar cada fase, `code-reviewer` antes del PR.

## Trampas de este worktree

- El shell escupe ruido `_encode:25: command not found: -e` antes de cada salida — es de la config
  de zsh de la máquina, no del comando. Ignorarlo.
- El pre-commit hook **rechaza commits que mezclan código y tests**. Dos commits, y cada
  `git add` / `git commit` en su **propia** llamada a Bash (el guard lee el staging *antes* de
  correr el comando, así que encadenar con `&&` no sirve).
- Heredocs muy largos con `python3 - <<'PY'` a veces los rechaza el guard de worktree por
  "demasiado complejo": usar las tools `Edit`/`Write` en ese caso.
