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
| 06 | `DataRow`, `LogLine`, `FollowTail` | ✅ hecho |
| 07 | Pantalla por pantalla (`02-pantallas.md`) | 🟡 lo que los datos permiten |
| 08 | Chrome de dos filas, veredicto, listas en lectura (§9) | ✅ hecho |
| 5b/5d | La LISTA de Ejecuciones — fila apilada en 390px, columnas en desktop | ✅ hecho |
| 6a/6b | El DETALLE de un run — cinco bandas, sin timeline inventado (R13) | ✅ hecho |

## Los siete pasos pedidos explícitamente

Todos ✅. Detalle en los commits; lo que quedó a medias está abajo.

---

## Pendiente

Todo lo que se podía construir con los datos que hay, está. Lo que queda está
bloqueado por algo concreto, no por falta de tiempo.

### Bloqueado en DISEÑO

**Nada.** Reordenar táctil está hecho: se arrastra desde el handle con Pointer
Events, que cubre mouse, dedo y lápiz con un solo código. Ver
`composables/useDragReorder.ts` para por qué ese gesto y no un long-press ni un
modo "reordenar".

### Bloqueado en SERVER

**`te esperan` e `ignoradas` en el dashboard**, y **la meta por proyecto del
switcher** (`42 tareas · 2 corriendo · 3 fallos`, frame 4c). Las dos necesitan
la disposición de cada tarea de CADA proyecto: hoy es una request por proyecto,
el mismo fan-out que `GET /api/tasks/dispositions` vino a borrar dentro de uno.
**Falta:** ese endpoint sin `projectId`, o un `GET /api/dispositions/summary`
con los cuatro conteos por proyecto. Un endpoint destraba las dos pantallas.

**El resumen en prosa de Qué sigue** ("3 tareas en vuelo y ninguna trabada;
#1240 falló dos veces en el mismo paso de tests"). Redactarlo en el cliente sería
escribir una conclusión que nadie calculó.

### Bloqueado en DATOS

**El timeline de un run** (`Leyó el issue · Creó la rama · Editó 3 archivos ·
Corrió los tests`). `execution_logs` guarda **una fila por run, no pasos**. Está
en la sección 7 del README como "no existe".

### Se puede hacer, sin bloqueo

**Nada queda.** Lo que faltaba se hizo:

- `FollowTail` + `LogLine` **cableados** en los logs del daemon. Lo que faltaba
  no era el componente: era que la lista tuviera scroll propio, sin el cual la
  corrección de posición no tiene dónde aplicarse.
- `DataRow` **existe**. Se migra una tabla cuando se la toca, no cinco en el
  mismo commit — eso haría irrevisable el diff.
- **El detalle de un run son cinco bandas** (turno 6): identidad · veredicto ·
  causa · log · acciones. Lo que R13 deja afuera y por qué: no hay timeline ni
  `paso 3/5` (`execution_logs` guarda una fila por run, no pasos), no hay
  `intento 2 de 2` (nadie los cuenta), y la comparación de lentitud dice
  «promedio» y no «p50» porque `ExecutionStats` trae `avgDurationMs` y
  `p95DurationMs`, no la mediana. `Reintentar` tampoco: es una acción sobre la
  TAREA, y esta feature no puede llamar al api de otra.
- **Ejecuciones: el detalle es la segunda columna sobre `--bp-split`**, como
  Tareas. Y como el ancho de la ventana deja de decir la verdad sobre el de la
  lista cuando hay una columna al lado, el corte de la fila es un
  `@container` sobre la lista, no un `@media`.
- **Ejecuciones (5b/5d) está hecha.** La lista era una tabla de siete columnas
  fijas que en 390px se resolvía con `overflow-x` + `min-width: 37rem` (R2), y
  decía el outcome con un badge propio mientras el resto de la app lo dice con
  `ExecutionStatusLine`. Ahora la fila es `features/executions/RunRow.vue`:
  glifo · `#issue` · título+razón · agente · dur. · verbo en una línea sobre
  768px, y cuatro líneas apiladas debajo. Se fueron con el rediseño las columnas
  Proveedor, Container, Fecha y el badge de Resultado — las tres primeras siguen
  en el detalle, y la edad la dice la razón (`terminó hace 3 d`).

Los otros tres streams (ejecuciones, logs del agent-host, runs abortados) siguen
sin `FollowTail`: cada uno necesita su propio alto, que es una decisión de
layout por pantalla y no un cableado mecánico.

---

## Lo aprendido, que vale más que la lista

**`bun run check` dejaba pasar pantallas rotas.** `RepoConfigModal` tenía un
`</div>` cerrando un `<label>` —no cargaba— y `vue-tsc`, biome y los tests
pasaron en verde: vue-tsc **saltea** el archivo que no puede parsear, y ninguno
de los tres monta un componente. Se cerró con dos cosas: `check:sfc` (el parser
de Vite dentro de `typecheck`) y tests de montaje para las cinco pantallas que
nadie montaba.

**Hay una tercera clase de bug que ninguna de las dos agarra: la geometría.** La
razón de la fila dibujándose encima de la fila siguiente, y el encabezado de
bucket tapando la primera tarea, compilaban, tipaban y pasaban los tests. Los
encontró alguien abriendo la app. Para eso, la herramienta es `bun run dev`.

**Correr `gh pr list` ANTES de empezar.** Esta sesión trabajó 33 commits sobre
`feat/mobile-nav` sin mirar seis PRs abiertos que se solapaban.

## Controles pedidos al design system

La tabla viva está en `apps/web/DESIGN_SYSTEM.md` § "Controles pedidos al
design system". Resumen: **reordenar táctil** (bloqueante), `FullScreen`,
`DataRow`, `LogLine`/`FollowTail`.

## Integración con los PRs que ya estaban abiertos (07-09)

Cuando esta rama se rebasó sobre `main`, ya se habían mergeado #159, #161, #162,
#163, #164 y #167. Tres cruces, resueltos así:

- **`TaskDetailModal`** → gana **#159**. Los dos hacen pantalla completa bajo
  768px, pero en desktop el suyo es un **panel lateral de 400px** en vez de un
  diálogo centrado, y eso es mejor: la lista no se pierde al abrir una tarea. Se
  descartó la migración a `FullScreen` de este archivo — el commit
  `feat(web): un detalle en mobile es una pantalla con ←` conserva en su cuerpo
  la versión previa a esta decisión; los que migran son los otros tres modales.
- **`RunningRunsPanel` (#162) + bucket `moving`** → **quedan los dos.** Parecían
  duplicados y el primer intento fue sacar el bucket; el código corrigió: el
  panel **delega en la fila** (`openRunFromPanel` la abre y scrollea hasta ella),
  así que sacarla rompía filtrar por `resultado:pending` y dejaba el botón de
  abortar inalcanzable. La división real es panel = *actuá ahora*, lista = *el
  registro*.
- **`TaskRunPreview` → `RunPreviewCard`** (#167) → el rename entró limpio.

### Una nota de proceso
Esta sesión trabajó 33 commits sobre `feat/mobile-nav` sin mirar qué más había
abierto. Había seis PRs con solapamiento real. **Correr `gh pr list` al empezar,
no al final.**

Y un detalle del repo que costó un PR: **GitHub borra la head branch
automáticamente** al mergear (no hace falta `--delete-branch`), y un PR cuya
base desaparece se cierra solo y **no se puede reabrir ni re-apuntar** — así
murió #160, que hubo que recrear como #167.

## Decisiones tomadas que conviene no re-litigar

- `--row-h` es grilla, `--tap-h` es blanco táctil. No se colapsan.
- Tres breakpoints: 768 / 640 / 1100. Un cuarto hay que justificarlo.
- Reordenar es `.drag-handle` y nada más — no vuelven los `↑`/`↓`.
- La disposición se decide en el server; el cliente no la recalcula.
- El orden se congela al abrir; reordenar es un gesto del usuario.
- Un control que falta se **pide** (ver el DS), no se inventa en el componente.
