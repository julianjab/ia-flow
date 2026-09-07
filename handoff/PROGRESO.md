# Progreso de implementación — handoff mobile

Estado vivo de la ejecución del `README.md` de esta carpeta. **Se actualiza en el
mismo commit que el trabajo que describe**, para que sirva de punto de retomada
si la sesión se corta.

Rama: `feat/mobile-nav`. Criterio de "hecho": `bun run check` en verde y
commiteado.

---

## Etapas del README

| # | Etapa | Estado |
| --- | --- | --- |
| 01 | Tokens táctiles | ✅ hecho |
| 02 | Kit de campo — 9 forms de source/provider + 3 textarea JSON | ⬜ pendiente |
| 03 | Contenedores: `FullScreen`, `BottomSheet`, `StickyActionBar` + los 6 modales | 🟡 `BottomSheet` y `StickyActionBar` hechos; `FullScreen` y los modales, no |
| 04 | Navegación: tab bar, `/mas`, switcher | ✅ ya venía hecho |
| 05 | `disposition` en el server | ✅ hecho |
| 06 | `DataRow`, `LogLine`, `FollowTail` | ⬜ pendiente |
| 07 | Pantalla por pantalla (`02-pantallas.md`) | ⬜ pendiente |
| 08 | Chrome de dos filas, veredicto, listas en lectura (§9) | ✅ hecho |

## Los siete pasos pedidos explícitamente

Todos ✅. Detalle en los commits; lo que quedó a medias está abajo.

---

## Pendiente, en orden de ejecución

> ✅ **P1 · El orden nuevo en las cuatro vistas** — hecho. `useDispositionOrder`
> (el orden congelado + el agrupado) lo comparten Qué sigue, Tareas y
> Ejecuciones. Board no agrupa por disposición a propósito: sus columnas SON
> los statuses, y el orden por disposición vive DENTRO de cada una — queda para
> P7, que es cuando se rediseña el board.

### P2 · Reordenar táctil — bloqueante en mobile
Consecuencia de borrar los ↑/↓: el drag nativo de HTML5 no dispara en táctil, y
bajo `--bp-shell` Pipeline, las acciones de una regla y los candidatos de
provider quedan de sólo lectura **sin que nada lo diga**. Pedido al DS.

### P3 · Etapa 03 — `FullScreen` y los seis modales
`AgentEditorModal` (40 KB), `RuleEditorModal` (24 KB), `RepoConfigModal`,
`ProjectCreateModal`, `StatusConfigModal`, `TaskDetailModal`. A3 del README:
"lo más roto en mobile".

### P4 · `ComboBox` a bottom sheet (T11 / R6)
Tiene los blancos táctiles pero sigue siendo un popover anclado: con el teclado
virtual arriba se va de la pantalla.

### P5 · Etapa 02 — el kit de campo
Nueve forms con prefijo propio (`.ghsf-`, `.gisf-`, `.jsf-`, `.sfs-`,
`.pc-field`, `.jpf-`) y los tres textarea de JSON.

### P6 · Etapa 06 — `DataRow`, `LogLine`, `FollowTail`
Los cuatro streams resuelven lo mismo por separado (`ExecutionsSection` 105 KB
y `ServerLogsSection` 73 KB).

### P7 · Etapa 07 — pantalla por pantalla
`02-pantallas.md`: detalle de tarea, detalle de run, dashboard, logs.

---

## Controles pedidos al design system

La tabla viva está en `apps/web/DESIGN_SYSTEM.md` § "Controles pedidos al
design system". Resumen: **reordenar táctil** (bloqueante), `FullScreen`,
`DataRow`, `LogLine`/`FollowTail`.

## Decisiones tomadas que conviene no re-litigar

- `--row-h` es grilla, `--tap-h` es blanco táctil. No se colapsan.
- Tres breakpoints: 768 / 640 / 1100. Un cuarto hay que justificarlo.
- Reordenar es `.drag-handle` y nada más — no vuelven los `↑`/`↓`.
- La disposición se decide en el server; el cliente no la recalcula.
- El orden se congela al abrir; reordenar es un gesto del usuario.
- Un control que falta se **pide** (ver el DS), no se inventa en el componente.
