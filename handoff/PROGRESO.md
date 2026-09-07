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
| 02 | Kit de campo — forms de source/provider + textarea JSON | ✅ hecho |
| 03 | Contenedores: `FullScreen`, `BottomSheet`, `StickyActionBar` + los modales | ✅ hecho |
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

### P2 · Reordenar táctil — bloqueante en mobile, BLOQUEADO en diseño
Consecuencia de borrar los ↑/↓: el drag nativo de HTML5 no dispara en táctil, y
bajo `--bp-shell` Pipeline, las acciones de una regla y los candidatos de
provider quedan de sólo lectura **sin que nada lo diga**.

No es implementable sin una decisión de diseño: hace falta el GESTO
(long-press + mover, o un modo "reordenar" explícito), no un ícono. Pedido en la
tabla del `DESIGN_SYSTEM.md`.

> ✅ **P3 · `FullScreen` y los modales** — hecho. `AgentEditorModal` y
> `RuleEditorModal` ya no eran overlays fijos (reemplazan la lista dentro del
> `<main>`), así que los que migraron son los cuatro que sí lo eran:
> `RepoConfigModal`, `StatusConfigModal`, `ProjectCreateModal` y
> `TaskDetailModal`. Los cuatro perdieron su copia v3 de la caja y de los
> campos.

> ✅ **P4 · `ComboBox` a bottom sheet** — hecho (T11, R6).

> ✅ **P5 · El kit de campo** — hecho. Se fueron los seis prefijos
> (`.ghsf-`, `.gisf-`, `.jsf-`, `.sfs-`, `.pc-`, `.jpf-`) y las dos copias del
> textarea de JSON, que ahora son `ui/JsonConfigField.vue`.

### P6 · Etapa 06 — `DataRow`, `LogLine`, `FollowTail`


🟡 **`LogLine` y `FollowTail` existen y están testeados; NO están cableados**, y
la razón es concreta: hoy el que scrollea es la PÁGINA, no la lista. `FollowTail`
corrige el `scrollTop` de su propio contenedor, así que para que sirva la lista
necesita alto propio y scroll propio — que es rediseñar la pantalla del stream
(A2), o sea P7. Cablearlo antes daría un componente montado que no hace nada,
que es peor que no tenerlo: parece resuelto.

Lo mismo con `LogLine`: la fila actual de `ServerLogsSection` es una grilla de
columnas configurables con detalle desplegable. Reemplazarla por `LogLine`
perdería la configuración de columnas — `LogLine` es el render de UNA LÍNEA para
mobile (A2: "una línea de log no se parte en dos: se trunca y se abre"), y
convive con la grilla de escritorio.

⬜ **`DataRow` no está.** Reemplaza cada tabla escrita a mano (tareas, board,
salud, providers, catálogo MCP).

### P7 · Etapa 07 — pantalla por pantalla

🟡 **Dashboard** — los contadores se reordenaron a sus ranuras (`fallaron hoy`
primero y en `--danger`; `terminaron hoy` atenuado, porque un contador de lo que
ya terminó no compite por atención) y el número baja a 24px bajo `--bp-split`.

⛔ **Faltan `te esperan` e `ignoradas`**, que el handoff pone al frente
("el número que hoy nadie ve"). Los dos necesitan la disposición de CADA tarea
de CADA proyecto, y hoy eso es **una request por proyecto** — el mismo fan-out
que `GET /api/tasks/dispositions` vino a borrar dentro de un proyecto. Sin un
agregado GLOBAL, dibujarlos sería inventarlos.
**Lo que falta en el server:** `GET /api/tasks/dispositions` sin `projectId`, o
un `GET /api/dispositions/summary` que devuelva los cuatro conteos por proyecto.

⛔ **Board** — el spec describe un board de TAREAS agrupadas por status, con
selector de columna en mobile. Hoy el tab `board` es la **configuración de
statuses** (`StatusesSection`), no un board de tareas: no es un rediseño, es una
pantalla nueva. Vale confirmarlo antes de construirla.

⬜ **Detalle de run** y **"por qué no corre"** (§3 de `02-pantallas.md`) sin
empezar. `run-preview` ya existe y `TaskRunPreview.vue` lo consume dentro del
detalle de tarea; falta la vista propia.

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
