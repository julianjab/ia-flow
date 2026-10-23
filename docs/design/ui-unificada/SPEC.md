# UI unificada: menú de Mac y web (teléfono y escritorio)

- **Diseño aprobado:** https://claude.ai/artifact/8LKgBYoiRfb9v35sRDF26m (versión `1792786543-91bb`)
- **Mockup sin claude.ai:** [`mockup.html`](mockup.html). Se abre solo en un navegador: 71 pantallas,
  31 del menú de Mac, 34 de la web en el teléfono y 6 de la web en escritorio. Cada sección se numera
  aparte («Mac 3» = la tercera del menú de Mac).
- **Fuera de este documento:** los túneles de julianjab.link se van del menú a **MacPulse** (ver «Fuera de alcance»).

## Objetivo

Hoy el menú (`apps/menubar`, Swift) y la web (`apps/web`, Vue) son dos productos con nombres, orden
y estética distintos. Además, la bandeja es un solo scroll de siete secciones donde todo compite.
El objetivo es un solo lenguaje con la misma estructura en los dos lados:

1. **Tres vistas que responden «qué hago ahora»**, con el mismo nombre en todos lados:
   **Para mí** (lo que espera algo tuyo, incluidas las mejoras), **En curso** (lo que corre, la cola,
   los lugares del runner y lo que terminó hace poco) y **Próximo** (las épicas, lo que puede arrancar,
   lo que espera a otra tarea y el resto del board).
2. **Saber dónde estás:** el runner y su estado siempre arriba, una ruta de vuelta en cada detalle
   («‹ Para mí / subscriptions #4281») y «Por qué te necesita» en una frase.
3. **Acciones rápidas al deslizar, todas adentro.** La card no muestra botones, salvo la primera de
   Para mí. Deslizarla muestra las rápidas; tocarla abre el detalle con todas.
4. **Que lo que no podés resolver deje de ocupar el primer lugar:** orden por fecha, **Posponer** y
   **Fijar arriba**.
5. **El asistente siempre a mano y con contexto**, sin ser una pestaña sin relación con lo que mirás.
6. **La estética del menú en la web:** neutros oscuros, la tipografía del sistema, el azul solo para
   la acción principal y el color solo para el estado.

## Sistema visual (tokens)

La fuente es el bloque `:root` de `mockup.html`. En la web reemplaza la paleta y la tipografía de
`apps/web/src/styles/theme.css` (hoy v4: teal y IBM Plex). En el menú se usan los colores semánticos
de SwiftUI más cercanos.

| Token nuevo | Valor | Uso | Reemplaza en `theme.css` |
| --- | --- | --- | --- |
| `--s0` | `#1c1c1e` | fondo de campos, segmentado, logs | `--bg` |
| `--s1` | `#262628` | superficie de pantalla | `--panel` |
| `--s2` | `#2f2f32` | card | `--panel-alt` |
| `--s3` | `#3a3a3d` | botón neutro, chip | `--panel-hi` |
| `--s4` | `#4a4a4e` | segmento elegido, barra vacía | — |
| `--line` / `--line2` | `rgba(255,255,255,.08)` / `.14` | bordes | `--border` / `--border-hi` |
| `--tx` / `--tx2` / `--tx3` | `#ececec` / `#c7c7cc` / `#a1a1a6` | texto 1.º/2.º/3.º | `--fg` / `--fg-mute` / `--fg-dim` |
| `--blue` | `#1f6feb` | **solo** la acción principal (texto blanco, 4.6:1) | `--accent` como relleno |
| `--link` | `#6cb6ff` | links, «Review», ruta de vuelta | — |
| `--green` / `--live` | `#7ee787` / `#3fb950` | corre / ok / punto en vivo | `--green` |
| `--amber` | `#e3b341` | te pregunta / espera / fijada | `--yellow` |
| `--red` | `#ff7b72` | falló / destructivo | `--red` |
| `--teal` | `#56d4c4` | PRD | — |
| `--ai` | `#d2a8ff` | **solo** salida del asistente (R16) | `--magenta` |

- **Tipografía:** `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif`.
  Mono (`"SF Mono", ui-monospace, Menlo`) solo para refs, ids, rutas y comandos. Se va el `@import` de
  IBM Plex. Escala: título de vista 26/32 bold; título de card 14/19 (16/22 en el teléfono) semibold;
  cuerpo 13/18 en el menú y 15/21 en el teléfono; meta 12 (13 en el teléfono).
- **Radios:** card 12 px, botón 8 px, segmentado 9/7 px, sheet 14 px (20 px en el teléfono), chip 6 px
  (píldora en el teléfono).
- **Blanco táctil:** se mantiene R1 en la web (`--tap-h` 44 px, `--tap-h-lg` 48 px). En el menú,
  botones de 30–36 pt.
- `DESIGN_SYSTEM.md` pasa a **v5**: se reescriben «Tokens», «Tipografía» y la sección v4.1 de la capa
  táctil. Las reglas R1–R19 siguen. R14 se ajusta a las tabs nuevas (ver «Navegación»).

## Navegación

| | Menú de Mac | Web · teléfono (<768 px) | Web · escritorio (≥768 px) |
| --- | --- | --- | --- |
| Vistas | segmentado bajo el header (Mac 1) | tab bar: Para mí · En curso · Próximo · ✦ Asistente (Teléfono 2) | menú lateral (Escritorio 1) |
| Runner | nombre + estado arriba; abre «Runners» (Mac 25) | igual; abre el selector (Teléfono 1) | arriba del menú lateral |
| Consulta (Estado, Mejoras, Webhooks, Config) | desde «Runners» | sheet «Más» desde el avatar (Teléfono 25) | menú lateral, bajo un separador |
| Asistente | caja fija al pie → panel encima (Mac 18) | tab propia y botón ✦ en el detalle | panel a la derecha (Escritorio 4) |
| Buscar | lupa / ⌘K (Mac 9) | lupa del header (Teléfono 11) | campo + ⌘K |

**Se eliminan:** la pestaña «Servicios» del menú (pasa a «Runners») y las tabs Webhooks y Config del
teléfono (pasan a «Más»).

## Pantallas y archivos

Los números de pantalla son los del mockup. «Nuevo» = archivo que se crea; lo demás se modifica.

### 1. Para mí (Mac 1–5, Teléfono 2–7, Escritorio 1)

- **Hero:** la primera decisión, con su botón principal, el PR y ⋯ (Mac 1).
- **Filas:** sin botón visible. Llevan meta (tipo en color · ref · antigüedad), el título en 2 líneas,
  una razón y la pista `‹ <acción>`.
- **Deslizar** (Mac 2, Teléfono 3):
  - A la izquierda: la acción principal (azul) y **Posponer** (gris).
  - A la derecha: **Fijar arriba** (ámbar).
  - Tocar o hacer clic abre el detalle.
  - En el Mac se desliza con dos dedos o arrastrando, como hoy.
- **Orden** (Mac 3, Teléfono 4): segmentado **Prioridad** (default: `priority` del runner) · **Más
  reciente** · **Más antigua** (por `InboxItem.since`). Las fijadas van siempre primero, en el orden en
  que se fijaron. La elección se guarda por runner.
- **Posponer** (Mac 3): «Hasta que cambie algo», «1 día», «1 semana» o «Elegir fecha…». La card pasa
  al grupo plegado **«Pospuestas · N»** al final, que dice que vuelven solas. Aparece el toast
  «Pospuesta hasta que cambie algo · Deshacer».
  - «Cambie algo» = cambia la huella `status | since | execution.id | execution.status | pr.number | kind`.
  - Una pospuesta **no cuenta** en el badge.
- **Grupos de decisiones** (Mac 4): varias del mismo tipo («Mergear 2 PRs») con una fila y un botón
  por tarea, más «Mergear los 2…».
- **Confirmación en línea:** en el lugar del botón dice qué se firma, dónde y con quién, con «Cancelar» y «Mergear ahora».
- **Error de acción:** el recuadro rojo con «→ qué hacer» y «Reintentar».
- **Menú ⋯ o clic derecho** (Mac 5, Teléfono 6 como hoja):
  - Preguntar sobre esta tarea (✦), Ver la última ejecución, Mover a ▸, Posponer ▸, Fijar arriba.
  - Abrir worktree del PR en iTerm (**solo Mac**), Pedir review en Slack (si el proyecto la declara).
  - Abrir el issue o el PR en GitHub, Copiar la ref.
  - Detener… (en rojo).
- **Mejoras:** fila punteada «N mejoras propuestas por la retro · Revisar ›».
- **Portapapeles de la Mac (solo web, Teléfono 7):** la pastilla `MacClipboardPill` se queda, con el
  estilo nuevo.

| Lado | Archivos |
| --- | --- |
| Web | `apps/web/src/features/inbox/decisions/{DecisionQueue,DecisionRow,FirstDecision,DecisionChild,InlineConfirm,ActionError,ActionButton,ReasonChips,InboxHeadline}.vue`, `apps/web/src/ui/SwipeRow.vue` (dos lados: izquierda N acciones, derecha 1), `apps/web/src/features/inbox/queue/{entries,build,kinds}.ts` (orden), `apps/web/src/features/inbox/state/queue.ts` |
| Web, nuevo | `apps/web/src/features/inbox/queue/snooze.ts` (huella, vencimiento y orden con fijadas; puro), `apps/web/src/features/inbox/state/snooze.ts` (persistencia por `serverKey`, como `view/storage.ts`), `apps/web/src/features/inbox/decisions/SnoozedGroup.vue`, `apps/web/src/features/inbox/decisions/SortControl.vue` |
| Menú | `apps/menubar/RunnerViews.swift` (secciones → tres vistas, hero, filas), `apps/menubar/Swipe.swift` (dos lados), `apps/menubar/RunnerModel.swift` (orden, fijadas, pospuestas, badge), `apps/menubar/Icon.swift` (el badge sin las pospuestas) |
| Menú, nuevo | `apps/menubar/Snooze.swift` (misma huella y reglas que `snooze.ts`; se guarda en `~/.config/ia-flow-menubar/snoozes.json`) |

### 2. En curso (Mac 6, Teléfono 8, Escritorio 2)

- **Lugares del runner:** una celda por lugar, ocupado («Build · #4295») o libre (punteada), y quién toma el libre.
- **Corriendo ahora:** cards con el agente, «Ahora: …» en mono, «Ver en vivo» y «Detener…». Si corren
  varios agentes en paralelo, una línea por agente (`AgentLanes`).
- **Esperando lugar** y **Terminó hace poco** (✓ ✕ ↻, agente, salida y hace cuánto).

| Lado | Archivos |
| --- | --- |
| Web | `apps/web/src/features/inbox/pipeline/{RunningList,RecentRuns,FreeSlots,PipelineStrip,PipelineCells,AgentLanes}.vue` (`PipelineStrip` deja de ser franja: su contenido pasa a la vista) |
| Menú | `apps/menubar/RunnerViews.swift`, `apps/menubar/ExecutionAgents.swift` |

### 3. Próximo (Mac 7–8, Teléfono 9–10, Escritorio 3)

- **Arriba:** el filtro de proyecto (solo con más de uno) y el link «Board ↗».
- **Épicas:** barra de avance, «Sigue #n · …», «2 te esperan · 2 corriendo», «Ver épica».
- **Pueden arrancar:** cada una con «Mover a ▾». El menú lista las columnas de `projects[].statuses`,
  la actual deshabilitada, y avisa «Se mueve con tu login, sin confirmar». Al mover sale el toast.
- **Esperan a otra:** «bloqueada por #n».
- **Resto del board:** una fila plegada por columna con su conteo (`BoardRest`).
- **Agregar un issue al board:** el issue (`owner/repo#n` o link), el proyecto (si hay más de uno), la
  columna (Todo por defecto), y el error con «→ qué hacer».
- Al pie, la **higiene del board**.
- **Nada queda afuera** (pedido explícito al aprobar):
  - **Todo completo.** «Pueden arrancar» y «Esperan a otra» muestran **todas** las cards de Todo del
    `feed`, sin el tope de 8 por grupo que tiene hoy el menú. Con más de 8, el grupo arranca mostrando
    8 y termina en «Ver las N» (se despliega en el lugar, sin navegar). El buscador y el tag de repo
    filtran sobre todas.
  - **Resto del board completo:** todas las columnas de `GET /api/board`, cada una con todas sus cards.
  - **Sección nueva «En los repos, sin card»:** los issues abiertos de **cualquier repo del catálogo
    del runner** (`projects[].repos`) que no tienen card en el board, agrupados por repo y el más
    reciente primero. Cada fila tiene la ref en mono, el título, la antigüedad, el autor y «Agregar al
    board ▾» (con las columnas del proyecto; Todo por defecto). Un repo que no se pudo leer muestra su
    error en una línea, sin tapar al resto. `truncated` muestra «Hay más en GitHub ↗».
  - **Contrato:** `GET /api/repos/issues?project=` → `RepoIssuesSchema` (`packages/shared/src/inbox.ts`).
    Lo arma `apps/runner-v2/src/inbox/` con la identidad del runner y un cache corto por repo (como
    `BoardReader`), invalidado por los webhooks `issues.*` del repo. Excluye los PRs, los cerrados y
    los que ya tienen card en cualquier board del runner. Tope de 100 por repo, el más reciente primero.

| Lado | Archivos |
| --- | --- |
| Web | `apps/web/src/features/inbox/pipeline/{EpicsPanel,EpicEntry,FeedList,BlockedList,MoveToSelect,AddToBoardForm,HygieneNote}.vue`, `apps/web/src/features/inbox/{BoardRest,InboxToolbar}.vue` |
| Menú | `apps/menubar/FeedViews.swift`, `apps/menubar/Feed.swift`, `apps/menubar/RunnerViews.swift`, `apps/menubar/RunnerAPI.swift` (decodifica `GET /api/repos/issues`) |
| Runner | `apps/runner-v2/src/inbox/runnerApi.ts` (ruta), nuevo `apps/runner-v2/src/inbox/RepoIssuesReader.ts` (+ su test), `apps/runner-v2/src/inbox/InboxService.ts` (excluir lo que ya tiene card) |
| Web, nuevo | `apps/web/src/features/inbox/pipeline/RepoIssuesList.vue`, `apps/web/src/features/inbox/state/repoIssues.ts` |

### 4. Épica (Mac 17, Teléfono 19, Escritorio 3 a la derecha)

- Arriba, el título, la barra de avance «19 de 24» y la línea «2 te esperan · 2 corriendo · 1 bloqueada».
- Botones «Abrir la épica en GitHub ↗» y «✦ ¿Qué le falta?» (abre el asistente con la épica como contexto).
- Los sub-issues van agrupados por columna, con su PR, qué los bloquea y «cerrarla destraba N» (`unlocks`).
- El grupo **«Fuera del board»** lleva los cerrados o sin card, con ↗: se abren en GitHub.
- Un hijo del board abre su detalle; «Volver» regresa a la épica.

Web: `apps/web/src/features/inbox/EpicDetailDrawer.vue`, `apps/web/src/features/inbox/state/epic.ts`.
Menú: `apps/menubar/EpicViews.swift`.

### 5. Buscar (Mac 9, Teléfono 11)

- **Buscador del runner:**
  - Un tag de repo y el texto (número, `repo#n`, link o texto aproximado).
  - Resultados «En la bandeja» y «En el resto del board».
  - Al pie, «Buscar «…» en GitHub».
- **Buscar en GitHub** (Mac 10, Teléfono 12):
  - Selector «Toda la-haus ▾» o un repo.
  - Aviso «Usa tu login de GitHub (sólo lectura)».
  - Cada resultado dice Abierto/Cerrado, issue/PR y «En el board · Review», o trae «Agregar al board ▾».
  - En el Mac, ⋯ abre el worktree en iTerm.

Web: `apps/web/src/features/inbox/{InboxSearch,SearchResults}.vue`, `apps/web/src/features/inbox/state/search.ts`.
Web, nuevo: `apps/web/src/features/github-search/` (paridad con el menú; hoy la web no busca en toda
la organización). Menú: `apps/menubar/{RunnerSearch,GithubSearchViews,GithubSearchModel}.swift`.

### 6. Detalle de tarea (Mac 11–14, Teléfono 13–16, Escritorio 1 a la derecha)

- **Header:**
  - La ruta de vuelta: el nombre de la vista de origen + la ref en mono.
  - ↗ a GitHub.
  - Debajo, el título y los chips: columna, PR, épica (navega).
- **Por qué te necesita:** recuadro azul de una o dos frases.
- **Pestañas:**
  - **Resumen:** la línea de tiempo de pasos.
  - **Ejecuciones · N:** la más nueva primero. Abre sola la que corre o la última que falló, y lleva
    «Ver la traza completa».
  - **Eventos:** cada evento con lo que decidió cada pipeline, más «¿Por qué no corrió?».
- **Variante «el agente te preguntó»** (Mac 12):
  - «Qué pasó».
  - «✦ Lo que dijo el agente», el único bloque en `--ai`.
  - «→ qué hacer».
  - El textarea «Tu respuesta», con la nota «Se publica como comentario en el issue, con tu usuario de GitHub».
  - «Detalle técnico» plegado.
- **Barra de acciones fija** (R3/R4): un primario, «✦ Preguntar» y «Más ▾» (en el teléfono, ⋯ abre la
  hoja). Tapa la tab bar.

Web: `apps/web/src/features/inbox/{TaskDetailDrawer,TaskDetailPanel,TaskActions,TaskAskBar,TaskEvents,TaskExecutions,ExecutionRow}.vue`,
`apps/web/src/features/inbox/decisions/DecisionDetail.vue`. Menú: `apps/menubar/RunnerViews.swift` (detalle),
`apps/menubar/RunTraceViews.swift`.

### 7. En vivo (Mac 15–16, Teléfono 17–18, Escritorio 2 a la derecha)

- **Chips:** «corriendo · 12 min», el agente o el pipeline, los tokens, «≋ N llamadas al modelo» y «🕓 N anteriores».
- **Agentes en paralelo:** chips para filtrar la traza por agente (Todos · reviewer ✓ · e2e-visual-qa
  ● «sin pasos hace 2 min»). Lo que es de la ejecución (pipeline, workspace) queda siempre.
- **«Ahora»** con el paso actual en mono.
- **Traza:** un paso por tool, con su descripción y lo que tardó. Un paso con error queda resaltado y,
  abierto, muestra «Input» y «Resultado».
- **Barra:** «Detener…» (destructivo), «✦ Preguntar» y copiar.

Web: `apps/web/src/features/inbox/{TaskExecutions,ExecutionRow,AgentLanes}.vue`. Menú: `apps/menubar/{RunTraceViews,RunTrace,RunWatch,ExecutionAgents}.swift`.

### 8. Asistente (Mac 18–22, Teléfono 20–24, Escritorio 4)

- **Chat:** el contexto en un chip («Sobre subscriptions #4301 ×»). Las propuestas van en una card
  `--ai` con un botón primario y «Ahora no».
- **Conversación nueva:** «¿Con quién?» (los agentes del asistente), «¿De qué querés hablar?» (todo el
  runner, un proyecto o una de las tareas urgentes), las preguntas para empezar y la pista `#` / `@`.
- **Crear un issue:**
  - La card «Issue para el board» con repo, título, «Ver el cuerpo ▾» y columna.
  - El botón «Crear y agregar al board…».
  - El resultado «✓ repo#n abierto y en <columna> · ver ↗».
  - Las «Tareas que mencionó, como están ahora».
- **Conversaciones:** buscador y lista por día.
- **Voz:** los switches «Leer las respuestas» y «Charla», la voz y la velocidad (1× · 1,25× · 1,5×), y la
  nota del dictado («enviar» / «listo» / 4 s).

Web: `apps/web/src/features/assistant/{AssistantLauncher,AssistantPanel,AssistantStart,AssistantComposer,AssistantConversations,AssistantProposalCard,AssistantTaskList,AssistantVoiceSheet}.vue`.
`AssistantLauncher` deja de ser burbuja: en el teléfono es la tab; en el escritorio, un panel a la derecha.
Menú: `apps/menubar/{AssistantViews,AssistantModel,Voice}.swift`. La pestaña se va y la caja va al pie
de `Views.swift`.

### 9. Mejoras (Mac 23–24, Teléfono 27–28)

Cada card lleva «Abrir issue…» (primario), «✦ ¿Por qué?» y «Descartar». El «¿Por qué?» es un chat con
la mejora arriba y las preguntas sugeridas. Web: `apps/web/src/features/improvements/{ImprovementsSection,ImprovementCard}.vue`.
Menú: `apps/menubar/ImprovementsViews.swift`.

### 10. Runner, estado, logs y cuenta (Mac 25–31, Teléfono 1, 25–26, 29–34)

- **Runners (Mac 25):**
  - La lista de runners con su estado.
  - «Estado del runner» y «Logs del server».
  - **Servicios en este Mac:** switch, chip de puerto que abre la URL y ⋯ (reiniciar, abrir, log en iTerm).
  - «Reiniciar todo», «Editar servicios…».
  - La cuenta de GitHub.
- **Elegir runner** (Teléfono 1): los estados «responde», «no responde» y «pide token», este con el
  campo abierto. Debajo, «Agregar otro».
- **Estado del runner:** primero «N cosas para mirar». Después responde, capacidad, memoria, disco,
  GitHub, Slack, asistente y los últimos avisos.
- **Logs:** segmentado Todo / Avisos / Errores, líneas en mono y «Copiar».
- **Iniciar sesión con GitHub:** el código grande, «Copiar», «Abrir GitHub ↗», «Esperando que lo
  autorices…» y «Cancelar».
- **Estados:**
  - Vacío: «Nada te espera».
  - Cargando: skeleton.
  - Runner caído: «Reintentar» y «Cambiar de runner»; lo último que se vio queda atenuado.
- **Solo Mac:**
  - El ícono de la barra con su badge.
  - Clic derecho: Actualizar, Abrir en una ventana, Editar servidores…, Editar servicios…, Iniciar sesión, Salir.
  - El **modo ventana** en tres columnas, con 📌.
- **Solo web:**
  - **Cómo se ordena Para mí**: las reglas en orden, «No se muestra» y el editor YAML con «Guardar» y «Volver al de la web».
  - Webhooks.
  - Config.
  - El detalle de un agente.

| Lado | Archivos |
| --- | --- |
| Web | `apps/web/src/views/{AppShell,ServerPickerView,ConfigView,WebhooksView,InboxView}.vue`, `apps/web/src/ui/{TabBar,BottomSheet}.vue`, `apps/web/src/features/servers/ServerCard.vue`, `apps/web/src/features/github-login/GithubLoginSheet.vue`, `apps/web/src/features/inbox/{RulesLegend,DashboardEditor}.vue`, `apps/web/src/features/config/*.vue`, `apps/web/src/features/ingress/IngressPanel.vue`, `apps/web/src/features/inbox/loading/SectionSkeleton.vue` |
| Web, nuevo | `apps/web/src/views/MoreSheet.vue` (el sheet «Más»), `apps/web/src/views/RunnerHealthView.vue` (hoy el estado del runner solo existe en el menú) |
| Menú | `apps/menubar/{Views,Components,main,RunnerHealthViews,Icon}.swift`, `apps/menubar/RunnerViews.swift` (logs) |

## Componentes que se reutilizan

- **Web:**
  - `ui/SwipeRow.vue`: se extiende a dos lados.
  - `ui/BottomSheet.vue`: el sheet «Más», las acciones en el teléfono y la voz.
  - `ui/TabBar.vue`: se cambian los destinos.
  - `ui/ConfirmDialog.vue`: no se usa, la confirmación es en línea (`InlineConfirm`).
  - `ui/CopyButton.vue`.
  - `ui/LogLine.vue`.
  - `decisions/InlineConfirm.vue`.
  - `decisions/ActionError.vue`.
  - `decisions/RefLink.vue`.
  - `composables/{useIsMobile,useBackClose,formatRelative}.ts`.
- **Menú:**
  - `Swipe.swift`.
  - `Components.swift`: botones, chips y switches.
  - Las pantallas existentes de épica, traza, búsqueda en GitHub y mejoras se re-estilan, no se reescriben.

## Textos exactos

| Dónde | Texto |
| --- | --- |
| Vistas | «Para mí», «En curso», «Próximo»; tab «Asistente» |
| Subtítulo del runner | «2 corriendo · 1 en cola · 1 de 3 lugares libres» (en el teléfono, «… · 1 libre») |
| Orden | «Orden» · «Prioridad» · «Más reciente» · «Más antigua» |
| Posponer | «Posponer «<título>»» · «Hasta que cambie algo» · «1 día» · «1 semana» · «Elegir fecha…» · «Vuelve sola cuando cambie algo en la tarea: un commit, un review o el CI.» |
| Grupo | «Pospuestas · N» · «vuelven cuando cambien» |
| Toast | «Pospuesta hasta que cambie algo · Deshacer» |
| Fijar | «Fijar arriba» · etiqueta «Fijada» |
| Deslizar (ayuda, primera vez) | «Deslizá a la izquierda: la acción principal y Posponer. A la derecha: Fijar arriba. Tocar la card: el detalle con todas las acciones.» (Mac: «Con dos dedos …», «Clic la card …») |
| Detalle | «Por qué te necesita» · «Resumen» · «Ejecuciones · N» · «Eventos» · «¿Por qué no corrió?» · «✦ Preguntar» · «Más ▾» |
| Pregunta | «Qué pasó» · «✦ Lo que dijo el agente» · «Tu respuesta» · «Se publica como comentario en el issue, con tu usuario de GitHub.» · «Detalle técnico» · «Responder» |
| Confirmación | «¿Mergear PR #n en <repo>?» · «Squash a main, firmado con @<login>.» · «Cancelar» · «Mergear ahora» |
| Error | «No se pudo <verbo>: <motivo>.» + «→ <qué hacer>» · «Reintentar» |
| En curso | «Lugares del runner» · «libre» · «Corriendo ahora» · «Esperando lugar» · «Terminó hace poco» · «Ver en vivo» · «Detener…» |
| Próximo | «Épicas» · «Pueden arrancar» · «Esperan a otra» · «Resto del board» · «Agregar un issue al board» · «Mover a ▾» · «Se mueve con tu login, sin confirmar.» |
| Asistente | «Pregúntale o pídele algo al asistente…» · «Seguí preguntando…» · «Sobre <ref>» · «Propuesta» · «Ahora no» · «¿Con quién?» · «¿De qué querés hablar?» · «Para empezar» · «Issue para el board» · «Crear y agregar al board…» |
| Vacío | «Nada te espera» · «2 corren y 1 está en cola. Te avisa el ícono cuando algo te necesite.» |
| Caído | «<host> no responde desde hace N min.» · «Reintentar» · «Cambiar de runner» |
| Servicios | «Servicios en este Mac» · «Reiniciar todo» · «Editar servicios…» · «Los túneles de julianjab.link pasan a MacPulse.» |

Voseo en todos los textos, como hoy. Sin mayúsculas sostenidas (v4.1).

## Estados

- **Cargando:** skeleton de tres líneas por card (`SectionSkeleton`); el header ya muestra el runner.
- **Vacío por vista:**
  - Para mí: «Nada te espera», con un link a En curso.
  - En curso: «Nada corre. N lugares libres».
  - Próximo: «No hay nada por arrancar».
- **Error de lectura:** el recuadro rojo con «Reintentar». Lo último leído queda atenuado (`opacity .35`), nunca vacío.
- **Sin login de GitHub:** las acciones que firman piden el login (sheet) en vez de fallar.
- **Error de acción:** queda pegado a la card que falló, con «→ qué hacer».
- **En vivo:** el punto verde con halo junto al runner mientras el stream SSE está conectado; sin halo cuando cae a polling.

## Responsive

- **Teléfono (<768 px):** tab bar al pie. El detalle es pantalla completa con su barra de acciones,
  que tapa la tab bar (R4). Los sheets suben desde abajo. Sin scroll horizontal (R2).
- **Escritorio (≥768 px):** menú lateral de 250 px y lista fluida. Desde 1100 px (`--bp-split`) el
  detalle, la épica o el asistente van en una columna de 440 px a la derecha; por debajo, el detalle
  es un drawer.
- **Menú:** popover de 420 × 780 pt. En modo ventana, las mismas tres columnas que el escritorio
  (menú lateral de 210, detalle de 380).

## Accesibilidad

- Todo lo presionable es `<button>` o `<a href>`, con `aria-label` en los íconos solos.
- El segmentado y la tab bar marcan la actual con `aria-current="page"`. Los switches van con `role="switch"` + `aria-checked`.
- **Deslizar nunca es el único camino** (R7): tocar abre el detalle, y el ⋯ o el clic derecho tienen
  las mismas acciones, Posponer y Fijar incluidos. En Mac, VoiceOver ofrece las acciones de la fila
  como `accessibilityAction`. En la web, la fila expone un botón ⋯ al foco del teclado.
- Contraste: texto ≥ 4.5:1 sobre su fondo (`--tx3` sobre `--s2` da 5.0:1; blanco sobre `--blue`, 4.6:1).
  El estado nunca va solo por color: siempre lleva palabra («Falló», «Pregunta», «Fijada»).
- Los toasts y los errores se anuncian (`role="status"` / `role="alert"`).
- El foco vuelve a la fila de origen al cerrar el detalle o un sheet (`useBackClose`).

## Paridad API ↔ web (CLAUDE.md)

- Orden por fecha: **sin cambio de API** (`InboxItem.since` ya existe).
- Posponer y Fijar, **fase 1: en el cliente**, por runner. La web los guarda en `localStorage`, como
  `features/inbox/view/storage.ts`; el menú, en `~/.config/ia-flow-menubar/`. No cruza el wire.
- Si se quiere que una pospuesta en el teléfono también se esconda en el Mac, hace falta la **fase 2**
  (ver preguntas abiertas): `GET/PUT /api/me/snoozes` en `apps/runner-v2/src/inbox/` y un schema
  `SnoozeSchema` en `packages/shared/src/inbox.ts`.
- La búsqueda en toda la organización y el estado del runner en la web usan endpoints que el menú ya
  consume (`/orgs/:org/repos` vía GitHub, `/health`, `/api/resources`, `/api/ingress`,
  `/api/webhooks/status`, `/api/logs`).

## Fuera de alcance

- **Túneles de julianjab.link:** el formulario «Nuevo túnel», el servicio del túnel y «Borrar túnel»
  salen del menú y pasan a **MacPulse**. Se quitan de `apps/menubar/Core.swift` (cloudflared + API de
  Cloudflare), `Model.swift` y `Views.swift`, y de la sección «Túneles» de `apps/menubar/README.md`.
  Implementarlos en MacPulse es otro trabajo, en su repo.
- Un modo claro del producto (el mockup es solo oscuro; la página del mockup sí tiene claro).
- La edición de Config (sigue siendo de solo lectura).
- Reordenar Para mí arrastrando a mano. Fijar y posponer cubren el caso; arrastrar queda para después
  si hace falta.
- La app Electron (`apps/desktop`): toma la web tal cual.

## Preguntas abiertas

1. **¿Posponer y Fijar se sincronizan entre el Mac y el teléfono?** La fase 1 es por dispositivo; la
   fase 2 los guarda en el runner por login de GitHub. Recomendación: arrancar con la fase 1 y medir.
2. **¿Qué cuenta como «cambie algo»?** La huella propuesta es `status | since | execution.id |
   execution.status | pr.number | kind`. ¿Un comentario nuevo en el PR debe devolverla? Hoy el
   `InboxItem` no lo trae.
3. **¿Una tarea fijada que deja de necesitarte se desfija sola?** Propuesta: sí, cuando sale de Para mí.
4. **«Elegir fecha…»:** ¿selector de fecha nativo o solo atajos? El mockup lo muestra como opción.
5. **El grupo de decisiones con «Mergear los 2…»:** ¿se permite mergear en lote o una por una con su
   confirmación? Hoy `DecisionChild` confirma cada una.
6. **Migración de DESIGN_SYSTEM v4 → v5:** ¿una pasada única de tokens (cascadea sola) y después
   componente por componente, como se hizo en v4?
