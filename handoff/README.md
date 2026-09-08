# Handoff — ia-flow: rediseño mobile y orden de la información

Repo: `julianjab/ia-flow` · branch `main` · scope `apps/web`

Este paquete cubre cuatro cosas, en el orden en que conviene implementarlas:

1. **Tokens táctiles** — un defecto de un solo token que rompe las 30 pantallas en mobile.
2. **Orden de la información** — ordenar por quién tiene que mover la próxima pieza, no por fecha.
3. **Navegación mobile** — eliminar el drawer y reemplazarlo por una tab bar de cuatro destinos.
4. **Pantallas** — el rediseño de seis pantallas más una nueva, dejando las otras 23 intactas.

Nada de esto elimina pantallas. Las 23 que no se rediseñan heredan tokens y siguen
alcanzables — sobre 768px por el sidebar de siempre, bajo 768px por la pantalla `Más`.

---

## Archivos de este paquete

| Archivo | Qué es |
| --- | --- |
| `README.md` | Este documento. El plan, los tokens, el modelo de orden y las reglas transversales. |
| `02-pantallas.md` | Especificación pantalla por pantalla: navegación, Tareas, detalle, Qué sigue, runs, board, dashboard. |
| `Componentes.dc.html` | **Especímenes visuales a tamaño real** de los 11 patrones transversales, hoy contra propuesta, en desktop y en 360px. Abrir en un navegador. |
| `Design System v5.dc.html` | Los 7 arquetipos de pantalla y el catálogo de 41 componentes con su regla mobile. |
| `Orden.dc.html` | El modelo de orden: las cuatro disposiciones, los desempates y qué cambia en cada pantalla. |
| `Mobile IA-Flow.dc.html` | Los prototipos de pantalla. Cuatro turnos, el más nuevo arriba. |
| `Design System Mobile.dc.html` | El mapa de las 30 pantallas y qué se toca en cada una. |
| `support.js` | Runtime de los `.dc.html`. Tiene que estar al lado de ellos para que abran. |

Los `.dc.html` se abren directo en un navegador, sin servidor.

El turno 5 de `Mobile IA-Flow.dc.html` es el estado más nuevo del rediseño: las páginas completas
con el chrome, el resumen y el orden ya aplicados. Está especificado en la sección 9.

---

## Orden de trabajo

Las dos primeras etapas no cambian visiblemente ninguna pantalla y arreglan las 30.
Empezar por otro lado significa rehacer trabajo.

| Etapa | Qué | Alcance |
| --- | --- | --- |
| **01** | Tokens táctiles: `theme.css` + `form-fields.css` | las 30 pantallas |
| **02** | Kit de campo: migrar los 9 forms de source/provider, unificar los 3 textarea de JSON, `EntornoSection` a v4 | los 5 formularios largos |
| **03** | Contenedores: `FullScreen`, `BottomSheet`, `StickyActionBar`; los 8 modales pasan a usarlos | formularios y detalles |
| **04** | Navegación: tab bar, `MoreView`, `ProjectSwitcherSheet`; sidebar limitado a ≥768px | el shell |
| **05** | Disposición en el server: campo `disposition` + razón en el agregado de tareas | el modelo de orden |
| **06** | Filas compartidas: `DataRow`, `LogLine`, `FollowTail` | tablas y streams |
| **07** | Pantalla por pantalla, según `02-pantallas.md` | el resto |
| **08** | Chrome de dos filas, resumen como veredicto, listas en lectura (sección 9) | listas y config |

Las etapas 02 y 06 son independientes entre sí y del resto: se pueden paralelizar.
La 07 depende de 01, 03, 04 y 05.

---

## 1. Tokens táctiles — empezar acá

`--row-h` es `1.375rem` sobre una raíz de 18px, o sea **24.75px**. Está bien como grilla de
fila en una tabla de escritorio, y es para eso que existe. El problema es que cinco controles
**presionables** tomaron ese mismo número como su alto:

| Control | Dónde se toca |
| --- | --- |
| `.ec-btn` | El ✕, el ↺ y las flechas de reordenar de **toda** lista editable: repos, agentes, statuses, reglas, acciones, tools, catálogo MCP. |
| `.ff-add` / `.ff-drop` | Agregar y quitar un ítem en cada lista de formulario: headers HTTP, env vars, args, condiciones, outcomes, params. |
| `.cs-header` | El encabezado plegable de `CollapsibleSection` — la navegación interna del editor de agentes (40 KB de formulario) y del de reglas. |
| `.select-row` | Toda fila de menú y de popover: `ComboBox`, selector de modelo, de evento, de provider. |
| `.ff-field` | Todo input del kit denso. Un input de 25px en iOS dispara el zoom automático al enfocarlo, porque su texto queda bajo 16px. |

Ninguna de las siete pantallas de configuración es usable en un teléfono, y no es por su
layout: es por esto. Rediseñar pantalla por pantalla sin arreglarlo deja el mismo blanco de
25px en cada una.

### La corrección

Separar la **grilla** del **blanco táctil**. `--row-h` sigue siendo `1.375rem` y sigue
gobernando el interior de una fila: el `line-height` de un chip, la altura de una celda de
tabla, el ritmo vertical. Se agregan cuatro tokens:

```css
--tap-h:      2.45rem;  /* 44px — mínimo de todo control presionable. Default, no excepción. */
--tap-h-lg:   2.67rem;  /* 48px — botón principal de pantalla, filas de barra de acciones.   */
--tap-h-sm:   2.22rem;  /* 40px — chip de filtro: muchos en fila y el destino es ancho.      */
--fs-input:   16px;     /* piso del texto de input/textarea bajo 768px. px absolutos.        */
```

`--fs-input` tiene que ser px absolutos: es lo único que evita el zoom de iOS.

Los cinco controles pasan a `--tap-h`. Un cambio en dos archivos CSS. Es el único cambio de
este handoff que toca los tokens — ni un color ni una fuente se modifican.

**Ver `Componentes.dc.html`, sección T1**: los cinco controles dibujados a tamaño real con la
caja de 44px punteada detrás, y al lado la versión corregida.

---

## 2. Breakpoints — consolidar cuatro en tres

Hay **cuatro** anchos distintos declarados en 28 media queries: 900, 768, 640 y 560. Los de 900
(editor de agentes, editor de reglas, dashboard) y los de 560 (AppShell) son cada uno una
decisión local que nadie más comparte, y eso significa que un formulario cambia de forma en un
ancho en el que su pantalla contenedora no cambia.

| Token | Ancho | Qué cambia al cruzarlo |
| --- | --- | --- |
| `--bp-shell` | **768px** | El chrome. Abajo: tab bar, sin sidebar, modales a pantalla completa, controles a `--tap-h`, inputs a 16px. Arriba: sidebar, modales centrados, densidad de consola. **Es el único breakpoint que decide si la app es táctil.** |
| `--bp-stack` | **640px** | Las grillas de dos columnas se apilan: la etiqueta pasa arriba del valor, `ff-row-split` se vuelve columna, la tabla se convierte en filas de dos líneas. Reemplaza los cuatro `640px` que ya existen y absorbe los `560px` del AppShell. |
| `--bp-split` | **1100px** | Aparece la segunda columna: panel de detalle al lado de la lista, índice del editor de agentes al costado del formulario. Es el `900px` de hoy, subido — a 900 con sidebar quedan 670px de contenido y dos columnas ahí no entran. |

Los tres van como variables en `theme.css` a modo de documentación, y como valores literales en
las media queries (CSS no acepta `var()` en la condición de un `@media`). Escribir el número
suelto está bien; inventar un cuarto ancho no.

---

## 3. Orden de la información

Tareas, runs y ejecuciones se ordenan hoy por fecha, y una fecha contesta *qué pasó* — no
*qué me toca*. Con agentes trabajando solos esas dos preguntas dejaron de coincidir: lo más
reciente es casi siempre lo que avanza sin vos, y lo que te espera es justamente lo que lleva
más tiempo quieto y por lo tanto queda al fondo.

Con nueve ítems reales de un proyecto, el orden por fecha pone las dos únicas cosas que no
avanzan solas en los puestos 7 y 9, y le da el podio a dos runs corriendo y un PR ya mergeado.
Ver la comparación lado a lado en `Orden.dc.html`.

### Las cuatro disposiciones

La pregunta que decide el bucket no es en qué estado está el ítem, sino **quién tiene que mover
la próxima pieza**. Es la misma pregunta para una tarea, un run y una regla, y por eso sirve
como orden único de la app.

| # | Disposición | Qué la define | Qué entra |
| --- | --- | --- | --- |
| 1 | **te espera** | Nada va a pasar hasta que vos hagas algo. No hay agente ni regla que lo tome. | Run fallido sin regla de retry · PR con CI verde esperando *tu* review · tarea que ninguna regla matchea · regla apagada que alguien espera · run abortado sin resolver. |
| 2 | **avanza solo** | Hay un agente corriendo, o una regla que va a disparar. Lo mirás; no lo tocás. | Run en vuelo · tarea en cola por capacidad · PR esperando el review de otra persona · fallo con regla de retry pendiente. |
| 3 | **trabado por otro** | Espera a otro ítem de la app, no a vos. La acción real está en el bloqueante. | Tarea bloqueada por un issue o un PR · tarea cuyo agente está sin cuota · run diferido por concurrencia. |
| 4 | **cerrado** | Terminó y el estado ya avanzó. Nadie espera nada. | PR mergeado · tarea en Done · run exitoso cuyo outcome ya movió el status. |

### El caso que hoy no existe

Un run que falló **con** regla de retry y uno que falló **sin** ella son idénticos en la app de
hoy: los dos dicen `✕ falló`. Pero uno se va a arreglar solo en dos minutos y el otro está
muerto hasta que alguien lo toque. Esa distinción es la que separa el bucket 1 del 2, y es la
información más valiosa que el server ya tiene y la UI no muestra: la contesta `run-preview`.

### Desempates dentro de "te espera"

En cascada:

1. **Cuánto desbloquea.** Cuántos ítems del bucket 3 dependen de éste. Un PR que traba cuatro
   tareas vale más que un fallo aislado, incluso si el fallo parece más urgente. Es el único
   criterio que mide *consecuencia* en vez de antigüedad.
2. **Cuánto lleva esperándote.** No la fecha del último evento: el tiempo desde que quedó en
   tus manos. Son dos números distintos — una tarea ignorada seis días tiene su último evento
   hace seis días, pero lleva seis días esperándote, y eso es lo que hay que decir.
3. **Costo de la acción.** A igualdad de lo anterior, primero lo que se resuelve con un toque
   (aprobar, reintentar, mover de status) y después lo que pide leer y decidir. Para que la
   lista sea empezable en dos minutos entre reuniones.

En los buckets 2, 3 y 4 manda el reloj, con signos distintos: en `avanza solo` primero lo que
arrancó hace más (es lo que puede estar colgado); en `cerrado`, lo más reciente. Un run
corriendo desde hace 40 minutos cuando el p50 del agente es 6 es la única fila del bucket 2 que
merece atención, y la antigüedad la sube sola.

### Seis reglas de orden

- **O1 · La razón viaja con la fila.** Una fila nunca dice sólo su estado: dice por qué está en
  su bucket. `falló · tests` pasa a `falló 2× · no hay regla de retry`. La primera describe;
  la segunda te dice que sos vos.
- **O2 · Cada fila termina en un verbo.** En el bucket 1, la última línea es la acción, no un
  link a la entidad: `→ Aprobar y mergear`. En los otros tres no hay verbo — si no te toca,
  ofrecer un botón es ruido.
- **O3 · El reloj cambia de sujeto.** `hace 22 h` es un dato sobre el sistema.
  `esperándote 22 h` es el mismo número dicho sobre vos.
- **O4 · Lo cerrado se colapsa.** El bucket 4 es una línea con su contador, plegada. Hoy nueve
  runs terminados dominan la pantalla de ejecuciones; son la parte del día que *no* hay que mirar.
- **O5 · El bloqueante es navegable.** Una fila del bucket 3 nombra a su bloqueante y linkea. Si
  el bloqueante está en el bucket 1, lo dice: `espera #1236 · que está en el puesto 01`. Así el
  orden se explica solo.
- **O6 · Un solo orden, tres vistas.** Tareas, Runs y Board no son tres listas con tres órdenes:
  son **recortes** del mismo orden. Runs = los buckets 1 y 2 filtrados a lo que tiene ejecución.
  Board = el mismo orden agrupado por status.

### Qué cambia en cada pantalla

| Pantalla | Cómo se ordena |
| --- | --- |
| Qué sigue | El bucket 1 completo y numerado, el 2 abajo sin numerar, el 3 y el 4 plegados. Es la pantalla que *es* este orden. |
| Tareas | Mismo orden con los cuatro encabezados de bucket, más los filtros. El orden por fecha queda como opción, no como default. |
| Runs / Ejecuciones | Arriba lo que falló y nadie va a reintentar; después lo que corre, lo viejo primero; los terminados en una línea plegada. Es el cambio más grande: hoy es cronológico puro. |
| Board | Las columnas quedan (son los status del proyecto), pero dentro de cada una el orden es por disposición, y el encabezado cuenta el bucket 1: `In progress · 6 · 2 te esperan`. |
| Dashboard | El contador que manda pasa a ser `te esperan`. `fallaron hoy` se parte en dos: los que tienen retry y los que no. |
| Logs | **No cambia.** Un log *es* cronológico y reordenarlo lo rompe. Se agrega un filtro `sólo lo que quedó sin resolver`. |
| Selector de proyecto | Los proyectos se ordenan por su cuenta del bucket 1, no alfabéticamente. |
| Pipeline · Agentes | Una regla apagada que alguien espera, o un agente con éxito bajo, suben al tope de su lista. |

### Los dos riesgos

**El orden que salta.** Un orden que depende del estado se reordena solo, y con el socket vivo
eso significa que la fila que ibas a tocar se mueve. **El orden se calcula al abrir la pantalla
y no se recalcula solo.** Los eventos en vivo cambian el contenido de la fila donde está, y
arriba aparece una línea: `3 cambiaron de lugar · reordenar`. Reordenar es un gesto del usuario.

**El bucket 1 que crece sin fin.** Si todo termina en `te espera`, la lista vuelve a ser una
bandeja de entrada y el orden no sirvió de nada. El indicador a mirar es cuántos ítems llevan
más de una semana esperándote: si son muchos, el problema no es la UI — faltan reglas en el
pipeline, y ahí la app tiene que decirlo en vez de listarlos otra vez.

---

## 4. Siete arquetipos de pantalla

Las 30 pantallas son siete formas repetidas. Definir el comportamiento mobile del arquetipo
arregla todas sus instancias de una vez.

### A1 · Lista + config por ámbito — 9 pantallas, el dominante

`agentes` `pipeline` `acciones` `tools` `system-prompts` `repos` `statuses` `providers` `mcp-catalog`

`.settings-section` → `.section-header` → dos `ScopeGroup` (propio arriba, heredado abajo) →
filas de `EditableCard` → modal de edición.

- **mobile** — La fila mantiene su contenido y su envoltura; lo que cambia es que las acciones
  (✕, ↺, flechas) salen del margen derecho y pasan a una fila propia abajo, a `--tap-h`. El
  encabezado de `ScopeGroup` se vuelve pegajoso al hacer scroll, porque con 20 reglas en una
  columna se pierde de vista si lo que se está mirando es propio o heredado. El botón primario
  del header baja a una barra fija al pie.
- **desktop** — Sin cambios. Sobre 1100px la lista puede convivir con el detalle en panel
  lateral en vez de modal.

### A2 · Stream en vivo — 4 pantallas, 180 KB de componente

`ejecuciones` `logs del daemon` `logs del agent-host` `runs abortados`

Filtros + `.live-toggle` + lista que crece por arriba + detalle en drawer.
`ExecutionsSection.vue` son 105 KB y `ServerLogsSection.vue` 73 KB: los dos resuelven el mismo
problema por separado.

- **mobile** — Una línea de log no se parte en dos ni se envuelve: se trunca y se abre. La lista
  es de una línea por evento —hora, nivel por color, origen, mensaje truncado— y el mensaje
  completo, el stack y el contexto viven en el detalle. Los filtros van a bottom sheet. El
  autoscroll se pausa al primer gesto hacia arriba y aparece un botón `↓ seguir`: perder el
  renglón que estabas leyendo porque llegó un evento es el defecto principal de este arquetipo.
- **desktop** — Igual que hoy, con el detalle en el drawer que ya existe.

### A3 · Formulario largo — 5 pantallas, lo más roto en mobile

`editor de agente · 40 KB` `editor de regla · 24 KB` `config de repo` `crear proyecto` `config de status`

Modal + `CollapsibleSection` por bloque + el kit de campo + sub-editores.

- **mobile** — Pantalla completa, no modal. Un bloque abierto por vez (acordeón exclusivo) con
  su encabezado pegajoso a `--tap-h`. `Guardar` y `Cancelar` en barra fija al pie, siempre
  visibles — en un formulario de 40 KB el pie del documento está a diez pantallas de scroll. El
  resumen truncado del encabezado plegado (`.cs-summary`) se oculta: a 390px no queda ancho y
  competía con el título. Un bloque con error de validación se abre solo y se marca en
  `--danger` en su encabezado, así se ve estando plegado.
- **desktop** — Sobre 1100px, índice de bloques al costado del formulario en vez de acordeón.

### A4 · Tabla de trabajo — 2 pantallas, ya resuelto

`tareas` `board`

Es el único arquetipo que ya tiene su `@media (min-width: 768px)` escrito en la dirección
correcta: mobile primero.

- **regla** — Una tabla con `grid-template-columns` en `ch` nunca cabe en 390px. Bajo 640px la
  fila pasa a dos líneas —identidad arriba, estado abajo— con la columna de glifo fija en 20px.

### A5 · Detalle de entidad — 3 pantallas

`detalle de tarea` `detalle de run` `salud de un agente`

Encabezado con identidad y tags → tarjeta de estado → cuerpo (timeline, tabla o razones) →
barra de acciones. La estructura no cambia entre estados; cambia qué tiene contenido y cuál es
la acción principal.

- **regla** — En mobile un detalle es una pantalla con `←`, nunca un modal centrado, y su barra
  de acciones **reemplaza** a la tab bar: dos barras se comen 108px de alto.

### A6 · Panel de métricas — 3 pantallas

`dashboard` `salud de agentes` `estado de webhooks`

`AgentHealthPanel` ya fuerza `min-width: 38rem` bajo 768px, o sea scroll horizontal de 684px en
una pantalla de 390.

- **regla** — Una tabla de métricas en mobile se recorta a las tres columnas que deciden algo
  (identidad, la métrica que importa, la desviación) y el resto se ve al abrir la fila. Scroll
  horizontal sólo si la tabla es de comparación explícita, y con la primera columna pegajosa.

### A7 · Selector de entrada — 4 pantallas, ya funcionan

`servers` `proyectos` `entorno` `escaneo`

Lista de tarjetas grandes, una decisión por pantalla. Ya son de una columna. Sólo heredan
`--tap-h` y, en `EntornoSection`, la migración a v4 que ya estaba pendiente.

---

## 5. Componentes transversales

Especímenes visuales a tamaño real en `Componentes.dc.html`. Catálogo completo de 41 componentes
en `Design System v5.dc.html`.

| # | Componente | Archivo | Qué hacer |
| --- | --- | --- | --- |
| T1 | Blanco táctil | `theme.css`, `form-fields.css` | Los cuatro tokens de la sección 1. **Primero esto.** |
| T2 | `EditableCard` | `ui/EditableCard.vue` | `.ec-btn` a `--tap-h`; `__actions` con `flex-basis: 100%` bajo 640px para que caigan a su propia fila en vez de comprimir el cuerpo. La caja ya está bien: envuelve y toda la fila es el blanco de click. |
| T3 | Kit de campo | `ui/form-fields.css` | `.ff-field` a `--tap-h` y 16px; `.ff-row-split` a columna bajo 640; `.ff-list-key` pierde su `flex: 0 0 12rem`; el par clave/valor pierde el `=` y se apila, con el ✕ alineado a la clave. |
| T4 | `ConditionRowsEditor` | `ui/ConditionRowsEditor.vue` | Bajo 640px: campo + operador en una fila, valor a lo ancho debajo, y **cada condición en una caja con borde** — sin eso, seis campos apilados no se leen como tres pares. El AND pasa a separador con reglas al costado. El conector sigue viviendo dentro de la fila. |
| T5 | `CollapsibleSection` | `ui/CollapsibleSection.vue` | Encabezado a `--tap-h` y pegajoso, `.cs-summary` oculto, acordeón exclusivo, marca de error visible estando plegado, `Guardar` fijo al pie. |
| T6 | `DataRow` (nuevo) | `ui/DataRow.vue` | Una línea con columnas en `ch` sobre 640px; dos líneas apiladas debajo. Reemplaza cada tabla escrita a mano: tareas, board, salud, providers, catálogo. |
| T7 | `LogLine` + `FollowTail` (nuevos) | `ui/` | Hora, nivel por color de glifo, origen, mensaje truncado a una línea. Nunca envuelve. `FollowTail` pausa el autoscroll al primer scroll hacia arriba y ofrece `↓ seguir · N nuevos`. Los comparten los cuatro streams. |
| T8 | `ScopeGroup` | `ui/ScopeGroup.vue` | Encabezado pegajoso. Lo heredado se lista **completo y se abre** (son reglas corriendo sobre este proyecto): se atenúa y se marca `global`, nunca se deshabilita la fila. El detalle heredado va en `<fieldset disabled>` y ofrece `Cerrar`, no `Guardar`. En General los encabezados no se dibujan: ahí las globales *son* las propias. |
| T9 | `FullScreen` · `BottomSheet` · `StickyActionBar` (nuevos) | `ui/` | Un solo timing para los tres usos del sheet: `translateY` en 150ms, backdrop al 60% que cierra al tocar, radio superior de 12px. `ConfirmDialog`: el destructivo **separado** por hairline y en último lugar, y el texto dice qué se rompe, no "¿estás seguro?". |
| T10 | `ExecutionStatusLine` · `TaskTags` · `ToggleSwitch` · `.kbd` | varios | `ExecutionStatusLine` **ya existe** en `components/`: extenderlo al board y al detalle en vez de reimplementarlo. Un chip no es presionable y su `line-height` es `--row-h` — está bien; si navega, `--tap-h-sm`. En `ToggleSwitch` toda la fila conmuta. La barra de `.kbd` no se renderiza bajo 768px (`v-if`, no `display: none`). |
| T11 | `ComboBox` | `ui/ComboBox.vue` | El popover se vuelve bottom sheet bajo 768px, con la búsqueda arriba y las elegidas al pie sobre el botón. Un popover anclado a un input queda fuera de la pantalla en cuanto sube el teclado virtual. |

### Ocho reglas transversales

Van al final del checklist de `DESIGN_SYSTEM.md`. Se aplican a cualquier pantalla, incluidas las
que este handoff no nombra.

- **R1 · Blanco táctil.** Todo lo presionable mide `--tap-h` o más, siempre — no sólo bajo un
  breakpoint. `--row-h` es grilla, no blanco.
- **R2 · Nada de scroll horizontal.** Excepto una tabla de comparación explícita, y ahí con la
  primera columna pegajosa. Un `min-width` en `rem` sobre una tabla es la señal de que faltó
  decidir qué columnas importan.
- **R3 · La acción principal no scrollea.** En mobile el `--primary` del header baja a barra
  fija al pie.
- **R4 · Una barra fija por vez.** Tab bar **o** barra de acciones, nunca las dos: 108px en una
  pantalla de 800 es el 13% gastado en chrome.
- **R5 · La etiqueta va arriba.** Bajo 640px, toda grilla `etiqueta · valor` se apila. Una
  etiqueta de `5rem` se lleva un cuarto del ancho de un teléfono — `AgentCard` ya lo resolvió así.
- **R6 · Overlay anclado, no.** Bajo 768px, popovers y dropdowns son sheets.
- **R7 · Sin hover como único camino.** Lo que sólo aparece en `:hover` es inalcanzable en
  táctil. Si es importante, se ve siempre; si no, va en el detalle.
- **R8 · Mobile primero en el CSS.** Reglas base para el teléfono y `min-width` para agregar
  densidad, como ya hace `TareasSection`. Los 27 `max-width` restantes son parches, y por eso
  siempre falta uno.

---

## 6. Vocabulario de estado de ejecución

Seis estados, uno por fila de tarea, siempre en el mismo orden de lectura:
**glifo · qué pasó · agente · duración**. `ExecutionStatusLine.vue` ya existe en `components/`.

| Estado | Cómo se lee | De dónde sale |
| --- | --- | --- |
| corriendo | `◐ implementer · paso 3/5 · 4m 12s` | `finishedAt` null |
| ✕ falló | `falló · tests · 6m 40s · 2 intentos` | `outcome` · `failureClass` |
| ✓ terminó | `terminó hace 19 h · 8m 21s · PR abierto · CI ✓` | `outcome` · `durationMs` |
| ○ sin ejecutar | `sin ejecutar · sin rama · sin PR` | agregado nuevo |
| ○ ignorada | `ignorada · ninguna regla matcheó su status` | `run-preview` |
| ⛔ bloqueada | `nunca se ejecutó · bloqueada por #1236` | `getBlockers` |

Dos reglas: un `✕` nunca aparece sin el motivo literal al lado, y un "no sé" no se dibuja como
"no hay" — si el dato no llegó, la línea no se pinta. Si el socket está caído, el punto vivo no
se pinta: un punto quieto insinúa actividad que no hay.

---

## 7. Qué necesita el server

**Ya existe.** `GET /api/executions` · `/active` · `/stats` · `GET /api/tasks/:id/run-preview` ·
`POST /api/tasks/:id/run` · `POST /api/executions/:id/cancel` · el WS de `execution:*`.
`run-preview` es la pieza central del modelo de orden y no hay que construirla — hay que
llamarla desde el listado.

**Falta agregar.**

- Último run por tarea de un proyecto, en una sola request. Hoy `/api/executions` filtra por un
  `taskId`; sin el agregado, un listado de 40 filas son 40 requests. Ídem los blockers.
- Campo `disposition` (1–4) con su razón, en el mismo agregado. **Se decide en el server, no en
  el cliente**: depende de las reglas, los blockers y la cuota, y el cliente no las conoce.
- `waitingOnYouSince`: el timestamp del evento que dejó al ítem sin nadie que lo tome — no el
  del último evento.
- Fan-out: cuántos ítems dependen de éste. Es invertir el grafo de `getBlockers`, que ya existe
  pero se consulta de uno en uno.

**No existe.**

- Pasos dentro de un run: `execution_logs` guarda una fila por run, no pasos. `RunTimeline`
  depende de esto.
- Aprobar o mergear un PR desde la app (hoy sólo se pide review en Slack).

Sin el fan-out el orden todavía funciona: el bucket 1 se ordena por antigüedad de espera y se
pierde sólo el primer desempate. Sin `run-preview` en el listado no funciona nada, porque no se
puede separar el bucket 1 del 2.

---

## 8. Lo que no se toca

23 pantallas no se rediseñan. No borrar ni migrar nada de esto. Sobre 768px se sigue llegando
por el sidebar de siempre; bajo 768px, por la pantalla `Más`. Ninguna queda inalcanzable.

- **Proyecto** — `overview`, `repos`, `provider`, `system-prompts`, `agentes`, `pipeline`,
  `acciones`, `tools`. Ya usan `.settings-section` y su header envuelve; heredan T1 y T3.
- **Server** — `/general/agentes`, `pipeline`, `system-prompts`, `providers`, `acciones`,
  `tools`, `mcp-catalog`, `entorno`, `escaneo`, `aborted-runs`, `logs`. Se editan desde el
  escritorio y en mobile se leen.
- **Entrada** — `/servers`, `/projects`. Ya son listas de una columna y funcionan hoy.
- **Agent host** — `/agent-host`, `/agent-host/logs`. Otro proceso y otra credencial: fuera del
  alcance. La tab bar no aparece ahí.

`SettingsSidebar.vue` **no se borra**: se envuelve en `@media (min-width: 768px)`.

---

---

## 9. Páginas completas — chrome, resumen y orden

T12, T13 y T14 estaban resueltos como componentes. Esta etapa los aplica a la página entera.
Frames: **5a** Tareas mobile · **5b** Ejecuciones mobile · **5c** Entorno del repo · **5d**
Ejecuciones desktop, en `Mobile IA-Flow.dc.html` (turno 5, arriba).

### El chrome de una lista son dos filas

| Fila | Alto | Qué lleva |
| --- | --- | --- |
| Identidad | `--tap-h` | `←` · nombre del proyecto como botón del switcher · sección como breadcrumb (segunda línea bajo 768px) · punto vivo · `⋯` |
| Controles | `--tap-h` | Segmentado de vista (Lista/Board) · el filtro activo · `filtros ⌄` que abre el sheet |

Todo lo demás sale de arriba: `prj_8f2a41` y la URL del repo van a `overview`; el rate limit de
GitHub y el conteo de activos, al sheet de `⋯`; la descripción de la sección se borra.

- **R12 · El chrome de una pantalla de lista son dos filas.** Identidad y controles, `--tap-h`
  cada una, en cualquier ancho. Nada de un `.pd-header` que repita lo que ya dice la barra.

Recuperado: header **135 → 44px** en desktop y **200 → 44px** en 390px; controles de lista
**109 → 44px**. La fila de chips con scroll horizontal desaparece — el resto de los filtros vive
en el sheet (R2, R6).

### El resumen es un veredicto

Tres contadores por disposición —`te esperan` en `--danger`, `corriendo`, `cerradas`— y debajo
sólo los agentes **fuera de banda**, uno por línea, con su razón literal. Los sanos son una línea
plegada con sus tasas. La tabla de diez columnas de `AgentHealthPanel` no se recorta a tres: se
saca de la pantalla de vigilancia y queda entera en la pantalla del agente, que es donde se
audita. El párrafo explicativo pasa al `title` de la línea de totales.

Recuperado: **418 → 123px**. En un teléfono de 800px, la primera fila de ejecuciones pasa de
estar a 610px del borde a estar a 246 — de una fila y media visible a siete.

### Listas editables: lectura por defecto

Sobre 8 ítems la lista arranca en modo lectura, una línea de `--row-h` por ítem (es grilla, no
blanco, porque no se toca). `editar` pone los campos y el `✕`, que mide 24px de caja y `--tap-h`
de área con un pseudo-elemento — así no agrega una fila. `+ header` es la última fila de la lista
y no se mueve de lugar. La barra de guardado reemplaza a la tab bar (R4).

Recuperado: 20 env vars, **1804 → 584px**.

### El encabezado de bucket

26px, pegajoso, con tres datos: la disposición, su cuenta y —sólo en `te espera`— el desempate
que gobierna abajo (`ordenado por lo que desbloquea, después por lo que lleva esperando`). Es la
misma pieza en mobile y en desktop: es lo que hace que Tareas, Runs y Board se lean como recortes
de un orden y no como tres listas (O6). `cerrado` es una línea plegada con su contador (O4).

### Cada verbo lleva a donde se ejecuta

Ninguna fila inventa una capacidad. El verbo del bucket 1 (O2) es un **destino**: si la app puede
ejecutarlo, llama a su endpoint; si no, navega a la pantalla —propia o de GitHub— donde eso se
hace hoy. El texto del verbo nombra el destino, no la intención.

| Verbo en la fila | Dónde se ejecuta | Estado |
| --- | --- | --- |
| `→ Reintentar` | `POST /api/tasks/:id/run` | in-app, existe |
| `→ Elegir agente y correr` | `GET /api/tasks/:id/run-preview` + `POST /run`, en sheet | in-app, existe |
| `→ Abortar` | `POST /api/executions/:id/cancel` | in-app, existe |
| `→ Resolver · aborted-runs` | `/general/aborted-runs?run=:id` | pantalla propia, existe |
| `→ Revisar el PR ↗ github` | `task.prUrl` → `github.com/<repo>/pull/N`, target `_blank` | **no existe en la app** |

Aprobar o mergear un PR desde la app es la única acción del bucket 1 que no tiene implementación
(sección 7). Hasta que exista, la fila no ofrece un botón que finja hacerlo: linkea al PR. Si más
adelante se implementa, cambia el destino del verbo y nada más de la fila.

---

## Cómo trabajarlo

Abrí `Componentes.dc.html` al lado del editor: es la referencia visual de cada corrección.
`02-pantallas.md` tiene la especificación de las pantallas que se rediseñan, con los frames de
`Mobile IA-Flow.dc.html` que le corresponden a cada una.

Para arrancar, un prompt que funciona:

> Leé `handoff/README.md`, secciones 1 y 2. Implementá los cuatro tokens táctiles en
> `apps/web/src/styles/theme.css` y aplicalos a los cinco controles listados en
> `apps/web/src/ui/form-fields.css` y `apps/web/src/ui/EditableCard.vue`,
> `CollapsibleSection.vue` y `ComboBox.vue`. Consolidá los cuatro breakpoints en los tres
> nombrados. No cambies ningún color, fuente ni layout: sólo alturas, tamaño de texto de input
> y los anchos de las media queries. Referencia visual: sección T1 de `handoff/Componentes.dc.html`.
