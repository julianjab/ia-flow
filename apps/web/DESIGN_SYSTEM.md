# apps/web — Design System v4 · mobile-first

**Rule zero:** antes de crear un componente nuevo o cambiar la UI de uno existente, **lee este archivo y `apps/web/src/styles/theme.css`**.

**Rule zero-bis — mobile first, sin dejar de lado el desktop.** El CSS base describe el teléfono y `@media (min-width: …)` **agrega** densidad para pantallas grandes. Un `max-width` es un parche, y por eso siempre falta uno. Los tres únicos anchos son `768` / `640` / `1100` (ver «Breakpoints»), y todo control presionable mide `--tap-h` en **cualquier** ancho, no sólo bajo un breakpoint. Las doce reglas transversales (R1–R12) están al final de este archivo y aplican a **toda** pantalla, incluida la que estés escribiendo ahora. `theme.css` es la fuente única: si algo de acá contradice al CSS, gana el CSS y este archivo está desactualizado — arréglalo en el mismo cambio.

v4 nace del mockup de rediseño del editor de agentes (`src/features/agents/`). Arranca por los tokens porque cascadean solos a cada pantalla; migrar componente por componente es el paso siguiente. Eso quiere decir que **vas a encontrar componentes todavía en v3** (mono en todo, radio 0, verde ácido). No los tomes como referencia: la referencia es este archivo.

## Qué cambió respecto de v3

| | v3 (console) | v4 (actual) |
| --- | --- | --- |
| Paleta | ANSI-16 literal, verde ácido | teal-sage + neutros cálidos |
| Tipografía | una sola mono en todo | tres roles: Condensed / Sans / Mono |
| Radio | `0 !important` en todo | token `--radius` (4px) / `--radius-sm` (3px) |
| Inputs | mono forzada | Sans por default, mono como opt-in |

Si estás mirando un componente con `border-radius: 0`, hex hardcodeados o `'SF Mono'` escrito a mano, es v3 sin migrar.

## Tokens (fuente única: `src/styles/theme.css`)

### Superficies

| Var | Uso |
| --- | --- |
| `--bg` | Fondo raíz de la app |
| `--panel` | Cards, tablas, popovers |
| `--panel-alt` | Filas alternas (zebra), cards secundarios, hover de botón |
| `--panel-hi` | Hover de fila, headers de panel, fondo de chip |
| `--border` | Hairlines entre celdas y bordes de card |
| `--border-hi` | Bordes de foco / énfasis |
| `--border-mute` | Separadores dentro de una lista |

### Texto

| Var | Nivel |
| --- | --- |
| `--fg` | Primario: títulos, valores |
| `--fg-mute` | Body copy, descripciones |
| `--fg-dim` | Meta, labels secundarios, unidades |
| `--fg-dimmer` | Placeholders, ausencia ("sin PR"), glifos apagados |

Los neutros son **cálidos** (`--fg: #ece9e2`), no gris azulado: es lo que hace que el teal lea como color elegido y no como "el verde que había". Nada por debajo de 4.5:1 contra su fondo. Si necesitás destacar, subí un escalón; no bajes el fondo.

### Acentos

| Var | Rol |
| --- | --- |
| `--accent` (`--green`) | Teal-sage. Foco, selección, éxito, PR abierto. `--green-hi` es su hover. |
| `--danger` (`--red`) | Errores, destructivo, PR cerrado |
| `--warn` (`--yellow`) | En curso, refining, bloqueos |
| `--info` (`--cyan`) | Rutas, repos, ramas, providers, referencias |
| `--ai` (`--magenta`) | Assist, propuestas de IA, PR mergeado |
| `--green-bg` / `--red-bg` / `--yellow-bg` | Fondos de estado |

Regla: cada estado usa **una** ranura. No hay dos "ok".

### Tipografía — tres roles, no uno

| Var | Cuándo |
| --- | --- |
| `--font-display` (IBM Plex Sans Condensed) | Headings y kickers. Ya aplicado a `h1`–`h6` por `theme.css` |
| `--font-body` (IBM Plex Sans) | Texto de UI, botones, inputs, descripciones. **Default del `body`** |
| `--font-mono` (IBM Plex Mono) | Código, valores literales, ids, paths, ramas, números de issue, chips |

La regla práctica: **mono es para lo que el usuario podría copiar y pegar**. Un título de tarea es prosa → Sans. `#1240`, `fix/sms-add-sid`, `PVTI_lADO…` → Mono.

Escala: `--fs-micro` · `--fs-chrome` · `--fs-body-sm` · `--fs-body`. Siempre el token, nunca `0.85rem` escrito a mano — la raíz vive en `html { font-size: 18px }` y esa es la única perilla para agrandar la interfaz entera.

### Grilla vs. blanco táctil — dos números, no uno

`--row-h` (`1.375rem` ≈ 25px) es la **grilla**: el ritmo vertical de una fila de tabla, el
`line-height` de un chip, el alto de una celda. Es lo que se **mira**.

Lo que se **toca** mide otra cosa. Cinco controles presionables habían tomado `--row-h` como su
alto y dejaban un blanco de 25px en un teléfono —y un input bajo 16px dispara el zoom automático
de iOS al enfocarlo—, así que el blanco táctil tiene tokens propios:

| Var | Valor | Cuándo |
| --- | --- | --- |
| `--tap-h` | `2.45rem` ≈ 44px | **Default de todo control presionable.** No es una excepción para mobile: es el mínimo en cualquier ancho. |
| `--tap-h-lg` | `2.67rem` ≈ 48px | Botón principal de pantalla, filas de una barra de acciones fija. |
| `--tap-h-sm` | `2.22rem` ≈ 40px | Chip de filtro: van muchos en fila y el destino es ancho. Un chip que **no** navega no es presionable y se queda en `--row-h`. |
| `--fs-input` | `16px` | Piso del texto de `input`/`textarea`. **px absolutos a propósito**: es lo único que evita el zoom de iOS, y un `rem` se escala con la raíz. |

Los que ya los usan: `.ec-btn` (`EditableCard`), `.ff-add` / `.ff-drop` / `.ff-field`
(`form-fields.css`), `.cs-header` (`CollapsibleSection`), `.select-row` (`theme.css`, y con él
`ComboBox` y todo popover). **Un control nuevo arranca en `--tap-h`; si querés menos, justificá
por qué no se toca.**

Un ✕ dentro de una fila no crece a 44px de caja —agregaría una fila entera a la lista—: mide
24px visibles y expande su área con `::before { content: ''; position: absolute; inset: 0 -8px }`
sobre un `position: relative`. Blanco táctil sin costo de layout.

### Breakpoints — tres, y ninguno más

Un cuarto ancho hace que un formulario cambie de forma en un punto donde su pantalla contenedora
no cambia. Los tokens viven en `theme.css` como documentación; en la media query va el número
literal (CSS no acepta `var()` en la condición de un `@media`).

| Token | Ancho | Qué cambia al cruzarlo |
| --- | --- | --- |
| `--bp-shell` | **768px** | El chrome. Abajo: tab bar, sin sidebar, modales a pantalla completa, popovers como sheets. **Es el único breakpoint que decide si la app es táctil.** |
| `--bp-stack` | **640px** | Las grillas `etiqueta · valor` se apilan, `ff-row-split` se vuelve columna, la tabla pasa a filas de dos líneas. |
| `--bp-split` | **1100px** | Aparece la segunda columna: detalle al lado de la lista, índice del editor al costado del formulario. |

Escribir el número suelto está bien. Inventar un cuarto ancho, no.


### Radio y sombra

- Radio por token: `--radius` para cards/controles, `--radius-sm` para chips y elementos chicos. No inventes `6px`.
- Sin `box-shadow` de color. Máximo el pulso de `.live-dot`.

## Primitivas listas para reutilizar

Antes de escribir CSS nuevo, buscá acá — todas viven en `theme.css` y son globales:

- `.panel` / `.panel__header` (`--dim`) — card con header en caja alta.
- `.settings-section` + `.section-header` / `.section-head-text` / `.section-head-actions` / `.section-desc` — **la caja de una pantalla de configuración.** Es la que usan Tareas, Board, Agentes, Pipeline, Acciones, Tools, System Prompts y Repos, y por eso las ocho tienen el mismo alto de caja, el mismo `h2` y el mismo espacio hasta la primera fila. Vivía copiada `scoped` en nueve componentes hasta que las copias derivaron (radios de 8/10px que el reset pisa, dos tamaños de `h2`, tres márgenes de descripción distintos): **no la vuelvas a declarar en un componente.**
- `ui/ScopeGroup.vue` — el grupo por ámbito dentro de una de esas secciones (ver abajo).
- `ui/EditableCard.vue` — **la caja de una fila editable**, para toda lista que se puede abrir a un
  detalle (repos, agentes, statuses, reglas, acciones, tools, catálogo MCP). Borde, hover, ✕ y área
  de click en un solo lugar — ver "Botones" más abajo. `padding: 0.65rem 1rem` (subido desde el
  `0.15rem 0.6rem` original en dos pasadas: primero a `0.4rem 0.75rem` en el ajuste de Pipeline
  —con contenido de varias líneas el padding vertical mínimo dejaba el texto pegado al borde de
  la caja—, después a este valor porque el paso anterior seguía leyéndose apretado. Es el
  primitivo de TODAS las listas editables, así que un valor más denso en una lista larga (Tools,
  catálogo MCP) es un costo real: menos filas por pantalla sin scrollear. Si una lista puntual
  necesita más densidad que esto, la respuesta es un override local en esa sección, no bajar el
  default compartido.
  El `gap` entre filas de una lista (`.rs-list`, `.repos-list`, etc.) es aparte y lo declara cada
  sección: **Pipeline usa `0.5rem`**, más separación que la densidad por defecto porque agrupa por
  evento (ver `groupByEvent` en `RulesSection.vue`) y una fila apretada contra la siguiente hacía
  difícil ver dónde terminaba un grupo y empezaba el otro.
- `.btn` + `.btn--primary` / `.btn--danger` / `.btn--destructive` / `.btn--ghost` — **usá esto en vez de reinventar `.btn-save`/`.btn-cancel` por componente.** Ver "Botones" más abajo para cuál va en cada caso.
- `.uc-label` — **el label de un campo**, y de cualquier dato con nombre (celda de tile, fila de
  meta). Caja alta, mono, con tracking, en `--fg-dim`. Ocho componentes se declaraban su propia
  copia idéntica (`.af-lbl`, `.cre-lbl`, `.wce-lbl`, `.na-lbl`, `.rse-lbl`, `.ts-lbl`…) porque la
  global estaba un escalón más apagada (`--fg-dimmer`, la ranura de los placeholders); se corrigió
  el token y se borraron las copias. **No la vuelvas a declarar.**
- `ui/form-fields.css` — **el kit de campo denso**: la caja (`.ff-field`), el hint (`.ff-hint`), el
  error (`.ff-error`), la fila de par clave/valor (`.ff-list-*`) y los botones de alta y baja de una
  lista (`.ff-add` / `.ff-drop`). Se importa con `<style scoped src="@/ui/form-fields.css">`, así el
  scope sigue siendo por componente. Es lo que usan los forms de acción, el editor de condiciones y
  el ámbito de una regla y los settings de provider; los forms de source todavía tienen su propia
  copia con otro prefijo (deuda, ver abajo). **Un formulario nuevo lo importa en vez de reinventar
  el input.**
- `ui/ConditionRowsEditor.vue` — la fila `campo · operador · valor`, con badge AND/OR opcional
  (`logic`), catálogo de valores por fila (`valueOptions`) y ops unarios (`opTakesValue`). Es la
  única: el `when` de un agente, el de una regla y las reglas de admisión de un agent-host la
  comparten. El conector vive **dentro** de la fila, no en un array paralelo.
- `.mono` — opt-in de la familia mono en un nodo suelto.
- `.kbd` / `.kbd--primary` — pill de tecla para la barra de hints.
- `.hairline` — separador de 1px.
- `.select-row` / `.select-row--active` — fila de menú con video inverso.
- `ui/BottomSheet.vue` — **el overlay de la capa táctil.** Bajo `--bp-shell` un popover anclado a su
  disparador queda fuera de pantalla en cuanto sube el teclado virtual (R6), así que todo overlay
  es este sheet: `translateY` en 150ms, backdrop al 60% que cierra al tocar, radio superior de
  12px. Sobre el breakpoint se dibuja centrado. Es un contenedor y nada más — el contenido va por
  el slot, y por eso puede vivir en `ui/`.
- `ui/StickyActionBar.vue` — **dónde vive `Guardar`** cuando el formulario mide diez pantallas
  (R3). **Reemplaza a la tab bar, no se suma a ella** (R4): dos barras fijas son 108px de una
  pantalla de 800 y compiten por el mismo pulgar. Lleva al lado qué hay sin guardar, porque un
  `Guardar` deshabilitado no dice por qué.
- `components/ListControlsBar.vue` — **la segunda fila del chrome de una lista** (R12): vista ·
  filtro activo · `filtros ⌄`. Bajo `--bp-shell` los filtros van al sheet y en la fila queda el
  filtro activo; arriba, el panel va inline y no hay botón — el input de filtros ES el flujo de
  esa pantalla.
- `components/BucketHeader.vue` — **el encabezado de un bucket de disposición**: 26px, pegajoso,
  con la disposición, su cuenta y el desempate que gobierna abajo. Es lo que hace que Tareas, Qué
  sigue, Runs y Board se lean como recortes del MISMO orden y no como cuatro listas.
- `ui/FullScreen.vue` — **un detalle o un formulario que ocupa la pantalla.** Bajo `--bp-shell` un
  detalle es una pantalla con `←`, nunca un modal centrado (A3, A5); arriba, el diálogo centrado
  que un mouse espera. Trae el backdrop, el `Escape`, el bloqueo del scroll de fondo y el pie que
  no scrollea (R3), y su barra reemplaza a la tab bar (R4).
- `ui/JsonConfigField.vue` — **el `Record<string, unknown>` editado como JSON crudo**, para el
  source o el provider que todavía no tiene formulario propio. Era la misma pieza escrita dos
  veces con dos prefijos.
- `ui/FollowTail.vue` — **un stream que crece sin robarte el renglón que estás leyendo** (T7).
  Corrige el `scrollTop` por lo que creció arriba y ofrece `↑ N nuevos`. Necesita que la lista
  tenga scroll propio.
- `ui/LogLine.vue` — **una línea de log, y una sola** (T7): hora · nivel · origen · mensaje, que
  se trunca y se abre. El nivel es el color de un glifo, no un badge.
- `composables/useDispositionOrder.ts` — **el orden congelado + el agrupado por bucket.** Lo
  comparten las vistas que son recortes del mismo orden (O6).
- `.drag-handle` — **el control de reordenar una lista**, y el único. Es un `button` con el glifo
  `⠿`: se arrastra con el mouse y se mueve con `ArrowUp`/`ArrowDown` cuando tiene el foco.
  **No hay botones `↑`/`↓`** — eran dos blancos más en una fila que ya tiene cuatro controles,
  haciendo el trabajo que el handle ya hace, y el que sobra es el que se toca por error. Que sea
  un `button` no es cosmético: arrastrar no existe sin mouse, y el orden de estas listas decide
  qué regla gana y qué provider corre. Lo comparten `RulesSection`, `ActionsEditor` y
  `ProviderChoicesEditor`, que lo tenían copiado con tres prefijos y tres alturas distintas.
- `.live-dot` — 7px con blink, para un run en vuelo. `.cursor-block` para el cursor de terminal.
- `[data-kbd-item]` — marcá la fila navegable y el foco lo pinta `theme.css`; no escribas tu propio `:focus-visible`.

## Botones

Una sola caja (`.btn`) y cuatro variantes. Lo que cambia entre ellas **no es el tamaño ni la forma: es el peso visual**, y el peso codifica cuánto cuesta deshacer la acción.

| Clase | Se ve | Cuándo |
| --- | --- | --- |
| `.btn` | contorno `--border-hi` sobre `--panel-hi`, texto `--fg-mute` | Lo neutro: `Cancelar`, `Cerrar`, un filtro, un toggle. **Es el default** — si dudás, es éste. |
| `.btn .btn--primary` | relleno `--accent`, texto `--panel` | **Uno por pantalla.** La acción que la pantalla existe para hacer: `Guardar`, `+ Agregar agente`, `Crear`. Dos primarios en la misma fila es que ninguno lo es. |
| `.btn .btn--danger` | contorno `--danger`, texto `--danger`, fondo `--red-bg` en hover | Peligroso pero **reversible**: `Archivar proyecto`, `Quitar de la lista`, `Revertir`. |
| `.btn .btn--destructive` | relleno `--danger`, texto `--panel` | Destructivo y **sin vuelta atrás**: `Eliminar permanentemente…`. Es el único botón que pesa más que el primario de su pantalla, y tiene que costar apuntarle. Va siempre detrás de una confirmación. |
| `.btn .btn--ghost` | sin borde ni fondo, texto `--fg-dim` | Acción terciaria dentro de una fila o un header, donde un borde más sería ruido. |

Reglas que no se ven en la tabla:

- **Orden en una fila de acciones: neutro → primario → peligroso.** El destructivo va último y separado; nunca pegado al primario, porque el gesto para uno queda a un pixel del otro.
- **El sufijo `…` significa "abre una confirmación"**, no "esto borra". `Eliminar permanentemente…` pregunta; `Eliminar permanentemente` (dentro del diálogo) ejecuta.
- **Deshabilitado, no escondido**, cuando la acción existe pero todavía no aplica (`Guardar` sin cambios): `.btn:disabled` ya lo atenúa. Se esconde sólo lo que en ese ámbito **no existe** (ver `ScopeGroup`: en un detalle heredado no hay `Guardar`, y por eso no se dibuja apagado).
- **El texto nombra la acción, no el widget.** `Archivar proyecto`, no `OK`.
- **Un ✕ o un ↺ dentro de una fila no es un `.btn`** — lo dibuja `EditableCard` (slot `actions`), que ya les da la caja de `--row-h`.

**Deuda conocida:** hay ~30 clases de botón por componente (`ts-btn`, `na-btn`, `rem-btn`, `pspt-btn`, `btn-save-sm`…) que reinventan esta caja con otros paddings y radios. No agregues una más; cuando toques un componente que tenga la suya, migrala.

## Campos — deuda conocida

Los labels y la fila de condiciones ya están unificados (ver las primitivas de arriba). Lo que
falta, en orden de lo que más se ve:

| Familia | Estado |
| --- | --- |
| Forms de **source** (`projects/sources/`) | cinco hermanos del mismo modal, cinco prefijos (`.ghsf-`, `.gisf-`, `.jsf-`, `.sfs-`) — y `GitHubIssuesSourceForm` perdió el `border-radius` que sí tienen los otros cuatro |
| Forms de **provider por agente** (`agents/providerForms/`) | `.pc-grid`/`.pc-field` copiados verbatim entre dos, y `.jpf-*` en el tercero. Los de settings del provider (`providers/*SettingsForm.vue`) ya están migrados |
| Textarea de **JSON** | tres copias (`.jsf-textarea`, `.jpf-textarea`, `ff-textarea`); las dos primeras con `ui-monospace, SFMono-Regular` escrito a mano en vez de `--font-mono` |
| Input de texto plano | diez archivos con `padding: 0.5rem 0.65rem; border: 1px solid var(--border-hi); border-radius: 6px` copiado — `6px` no es token y `--border-hi` es el borde de **foco**, no el de reposo |
| Listas `+ agregar` / `✕` | seis vocabularios (`.ff-*`, `.oe-*`, `.tp-*`, `.btn-add-mcp`, `.srs-*`, `.loe-x`); el de `ToolParamsEditor` (`.btn` densificado) es el correcto |
| `EntornoSection.vue` | v3 entero: `box-shadow` azul fuera de la paleta, `'SF Mono'` literal, `.save-button` propio |

Cuando toques uno de esos archivos, migralo al kit — no le agregues un campo más con el prefijo
viejo.

## Ámbito: lo propio y lo heredado

Cinco dominios se configuran en dos niveles —agentes, reglas (Pipeline), acciones, tools y system prompts— con la misma convención: `projectId: null` es **global** y lo ve todo el mundo; `projectId: 'X'` es de X. Un proyecto ve la **unión**: lo suyo más lo global.

La primera pregunta de esas pantallas no es "¿qué hay acá?" sino **"¿qué puedo tocar acá?"**, así que la respuesta es estructural y no un cartel:

- **Dos grupos, siempre en el mismo orden:** lo propio arriba, lo heredado abajo. Los dibuja `ScopeGroup` (`variant="own" | "inherited"`), con el contador al lado del título y, en el heredado, el badge `solo lectura aquí` más una línea que dice **dónde sí se edita** (`edit-hint="General → Pipeline"`). Sin esa línea, "no se puede" es un callejón sin salida.
- **Los encabezados aparecen sólo si hay dos ámbitos que distinguir.** En General —donde las globales *son* las propias— serían chrome que no informa nada.
- **Lo heredado se lista completo y se abre.** No es una nota al pie: son reglas y agentes que están corriendo sobre este proyecto. La fila es clickeable y lleva al **mismo** detalle que la de una propia.
- **El detalle heredado se lee entero, no se toca.** El cuerpo del formulario va dentro de un `<fieldset :disabled>` —el navegador desactiva todo control anidado sin que cada sub-editor reciba un prop— y el pie ofrece `Cerrar` en vez de `Cancelar`/`Guardar`. Un formulario editable que descarta lo escrito es una promesa falsa; esconder sólo el botón Guardar no alcanza.
- **Nunca deshabilites la fila para "avisar" que es heredada.** Se atenúa (`muted`) y se marca con el tag `global`; el camino a leerla queda abierto.

Al escribir el `<fieldset>` hay que neutralizarle el chrome que trae por default: `border: 0; margin: 0; padding: 0; min-inline-size: 0` — sin lo último no se encoge dentro de un contenedor flex.

## Trampas conocidas

- **`a:hover` global pinta el fondo.** `theme.css` define `a { color: var(--accent) }` y `a:hover { background: var(--accent); color: var(--panel) }`. Si tu componente tiene un `<a>` que no debe comportarse como link de texto (un chip, un tag, una fila clickeable), **redefiní `background` explícitamente en tu `:hover`** — pisar sólo `color` deja el fondo verde.
- **Los inputs traen `color: … !important`.** Es para que el CSS legacy con `background: #fff` siga legible. No pelees contra eso; sacá el `#fff`.
- **`h1`–`h6` ya son `--font-display` y `font-weight: 700`.** No los vuelvas a declarar.

## Patrones de vista

- **Header de sección:** título en `--font-display`, caja alta, `letter-spacing: var(--tracking-hd)`, mismo tamaño que el cuerpo — la jerarquía la da la caja alta y el tracking, no el tamaño. Sub-copy en `--fg-dim`. Usá `.section-header` con `.section-head-text` (el texto, que se encoge) y `.section-head-actions` (los botones, que no): sin eso un título largo empuja el botón primario fuera de la caja.
- **Sub-navegación:** en el sidebar (`SettingsSidebar.vue`, prop `children`). **No** tab strips arriba del contenido.
- **Tabla:** grid con `grid-template-columns` en `ch`, filas de `--row-h`, hairline `--border-mute` entre filas.
- **Card de lista:** borde `--border`, hover que cambia superficie a `--panel-hi` y marca el borde izquierdo con la ranura del dominio (`--info` para algo navegable). El foco lo pone `[data-kbd-item]`.
- **Chip / tag:** una sola caja para todos los tipos — `line-height: var(--row-h)`, mono, `--radius-sm`, borde hairline. Lo que varía entre tipos es **el color del glifo**, no la caja: así una fila de tags heterogéneos se lee como una unidad.
- **Truncado:** truncá lo mínimo. Dentro de un chip, sólo el texto variable (el glifo y el estado quedan siempre visibles). Un título de lista **envuelve**, no trunca: esconder el final de un título esconde justo lo que distingue una fila de otra.
- **Ausencia:** decila, no la calles — `sin rama`, `sin PR` en `--fg-dimmer`. Pero sólo cuando *sabés* que no hay; si el dato no llegó, no muestres nada (un "no sé" dibujado como "no hay" es peor que el silencio).
- **Selección:** video inverso (`background: var(--accent); color: var(--panel)`); nunca outlines de color.

## Glifos

`●` proceso vivo / abierto · `○` detenido / draft · `◐` en curso · `✓` completado / mergeado · `✕` fallo / cerrado · `⛔` bloqueado · `⎇` rama · `▸` cursor de fila · `→` acción sugerida · `↗` abre afuera · `➜` prompt · `✦` salida de IA · `·` detalle secundario. Preferí Unicode sobre íconos SVG.

## Errores

Un error no es un toast rojo. Es una línea `✕` en `--danger` con el mensaje literal del proceso y, debajo, una línea `→` en `--info` con la acción que lo resuelve. Copiable entera.

## Cuando falta un control — se pide, no se inventa

Un control que no está en este archivo **no se resuelve en el componente**. Un `<div>` con
`@click` que hace de botón, un `⠿` decorativo que sólo funciona con mouse o un chip que en
realidad navega son la forma en la que un sistema se desarma: cada uno se ve distinto, ninguno
tiene estado de foco, y la deuda de treinta clases de botón de la que habla este archivo empezó
exactamente así.

**El procedimiento, en tres pasos:**

1. **Buscá si ya existe con otro nombre.** Es el caso más frecuente. `.btn` y sus variantes,
   `.select-row`, `.drag-handle`, `EditableCard`, `ScopeGroup`, `CollapsibleSection`,
   `ConditionRowsEditor`, `ComboBox`, `BottomSheet`, `form-fields.css`. Si estás por escribir un
   `border: 1px solid var(--border-hi)` sobre un `height`, casi seguro estás reescribiendo uno.
2. **Si no existe, pedilo — y decí dónde MÁS sirve.** Un control que sólo sirve en una pantalla
   es una decisión local; uno que aparece en tres es una pieza del sistema, y la diferencia
   cambia cómo se diseña. En el pedido va: **qué decide** el control (no cómo se ve), **dónde
   más aparece** el mismo problema hoy, y **qué se rompe** sin él —si el trabajo puede seguir con
   una solución provisoria, o si queda bloqueado.
3. **Mientras tanto, degradá a algo que ya exista** y anotalo. Un `.btn` de más es reversible;
   un control nuevo a medio hacer se copia a otras tres pantallas antes de que nadie lo revise.

**Un pedido bien escrito tiene esta forma:**

> **Reordenar con el dedo.** Decide el orden de una lista donde el orden significa algo (qué
> regla gana, qué provider corre). Hoy sólo hay `.drag-handle`, que usa el drag nativo de HTML5
> y **no dispara en táctil**: bajo `--bp-shell` la lista es de sólo lectura sin que nada lo diga.
> Aparece en `RulesSection`, `ActionsEditor` y `ProviderChoicesEditor`. Bloqueante para
> reordenar en un teléfono; el teclado sigue funcionando en desktop.

### Controles pedidos al design system

Lo que hoy falta, con dónde más serviría. Un control que aparece en la columna «también sirve
en» con dos o más entradas es del sistema, no de la pantalla que lo pidió.

| Control | Qué decide | También sirve en | Estado |
| --- | --- | --- | --- |
| **Reordenar táctil** | El orden de una lista, con el dedo. `.drag-handle` usa el drag nativo de HTML5, que **no dispara en táctil**: bajo `--bp-shell` esas listas quedan de sólo lectura sin que nada lo diga. | Pipeline (reglas), acciones de una regla, candidatos de provider, statuses | **Pedido — bloqueante en mobile** |
| **`DataRow`** | Una fila de datos: columnas en `ch` sobre 640px, dos líneas apiladas debajo. Reemplaza cada tabla escrita a mano. | Tareas, board, salud, providers, catálogo MCP | Pedido |
| ~~`StickyActionBar`~~ | — | — | **Hecho** — `ui/StickyActionBar.vue` |
| ~~`FullScreen`~~ | — | — | **Hecho** — `ui/FullScreen.vue` |
| ~~`LogLine` + `FollowTail`~~ | — | — | **Hechos** — `ui/`; sin cablear hasta que el stream tenga scroll propio (ver `handoff/PROGRESO.md`) |
| ~~Barra de controles de lista~~ | — | — | **Hecho** — `components/ListControlsBar.vue` |
| ~~Encabezado de bucket~~ | — | — | **Hecho** — `components/BucketHeader.vue` |
| ~~Segmentado de vista~~ | — | — | Cubierto por `components/ListBoardToggle.vue` |

Cuando uno de estos llegue diseñado, se agrega arriba con su primitiva y se borra de esta tabla.

## Doce reglas transversales — R1 a R12

Aplican a **cualquier** pantalla, incluidas las que ningún rediseño nombra. Son el criterio con el
que se revisa un cambio de UI: si una no se cumple, o se arregla o se dice por qué en el PR.

- **R1 · Blanco táctil.** Todo lo presionable mide `--tap-h` o más, **siempre** — no sólo bajo un
  breakpoint. `--row-h` es grilla, no blanco.
- **R2 · Nada de scroll horizontal.** Excepto una tabla de comparación explícita, y ahí con la
  primera columna pegajosa. Un `min-width` en `rem` sobre una tabla es la señal de que faltó
  decidir qué columnas importan.
- **R3 · La acción principal no scrollea.** Bajo 768px el `.btn--primary` del header baja a una
  barra fija al pie.
- **R4 · Una barra fija por vez.** Tab bar **o** barra de acciones, nunca las dos: 108px en una
  pantalla de 800 es el 13% gastado en chrome.
- **R5 · La etiqueta va arriba.** Bajo 640px, toda grilla `etiqueta · valor` se apila. Una
  etiqueta de `5rem` se lleva un cuarto del ancho de un teléfono.
- **R6 · Overlay anclado, no.** Bajo 768px, popovers y dropdowns son bottom sheets. Un popover
  anclado a un input queda fuera de pantalla en cuanto sube el teclado virtual.
- **R7 · Sin hover como único camino.** Lo que sólo aparece en `:hover` es inalcanzable en
  táctil. Si es importante, se ve siempre; si no, va en el detalle.
- **R8 · Mobile primero en el CSS.** Reglas base para el teléfono y `min-width` para agregar
  densidad. Un `max-width` nuevo necesita justificarse.
- **R9 · Una sola barra de identidad.** El chrome y el encabezado de página no repiten el mismo
  nombre. Si el nombre está en la barra pegajosa, la página arranca en su contenido — y la barra
  mide `--tap-h`, no más, porque lo que hay ahí se toca.
- **R10 · Un resumen nombra excepciones, no filas.** Un panel de métricas arriba de una lista
  muestra lo que está **fuera de banda** y cuenta el resto. La tabla completa no se recorta para
  caber: se muda a la pantalla donde se audita. Y **un contador en cero no se dibuja**.
- **R11 · El blanco táctil es área, no alto — y editar es un modo.** R1 exige 44px de área de
  toque; no autoriza a duplicar el alto de una lista. Una lista larga se **lee** densa
  (`--row-h` por fila) y se **edita** a `--tap-h`, y el control de agregar es la última fila de la
  propia lista.
- **R12 · El chrome de una pantalla de lista son dos filas.** Identidad y controles, `--tap-h`
  cada una, en cualquier ancho. Nada de un header de página que repita lo que ya dice la barra.

## Checklist antes de tocar UI

- [ ] Leí `theme.css` y este archivo.
- [ ] Uso tokens, no hex ni tamaños sueltos (`grep -n '#[0-9a-fA-F]\{3,6\}' <file>` sale vacío).
- [ ] Reutilicé una primitiva (`.btn`, `.panel`, `.uc-label`, `.kbd`) en vez de reinventarla.
- [ ] Los botones usan `.btn` + variante; hay como mucho un `--primary` en la pantalla, y el destructivo va último y detrás de una confirmación.
- [ ] Radios por token; ningún `0` ni `6px` a mano.
- [ ] Las filas y chips miden `--row-h` o un múltiplo — y **todo lo que se toca** mide `--tap-h`
      (R1). Los inputs bajan a `--fs-input` bajo 768px.
- [ ] El CSS arranca en mobile y agrega con `min-width` (R8); no inventé un cuarto breakpoint.
- [ ] Sin scroll horizontal (R2) y sin hover como único camino (R7).
- [ ] Bajo 768px: la acción principal está en barra fija al pie (R3), hay **una** sola barra fija
      (R4), y los popovers son sheets (R6). Bajo 640px, `etiqueta · valor` se apila (R5).
- [ ] No repetí la identidad de la pantalla en un header propio (R9, R12): el chrome de una lista
      son dos filas de `--tap-h`.
- [ ] Un resumen nombra excepciones y no dibuja los ceros (R10).
- [ ] Una lista de más de 8 ítems arranca en lectura y el `+ <ítem>` es su última fila (R11).
- [ ] Si la lista se reordena, usa `.drag-handle` — no escribí `↑`/`↓` ni un `⠿` decorativo.
- [ ] Si me faltó un control, lo pedí (ver «Cuando falta un control») en vez de inventarlo en el
      componente, y degradé a una primitiva existente mientras tanto.
- [ ] No redeclaré `.settings-section` / `.section-header` / `.section-desc` en el componente.
- [ ] Los campos usan `ui/form-fields.css` y los labels son `.uc-label` — no declaré mi propio
      `.xx-lbl` ni mi propio `.xx-field`.
- [ ] Si la pantalla se configura en dos ámbitos: lo propio y lo heredado están en dos `ScopeGroup`, lo heredado abre el mismo detalle, y ese detalle no ofrece guardar.
- [ ] Mono sólo en lo copiable; prosa en Sans.
- [ ] Si hay `<a>` que no es link de texto, su `:hover` redefine `background`.
- [ ] Contraste ≥ 4.5:1 en la paleta oscura.
- [ ] Los atajos de teclado están expuestos con `.kbd`.

Si estás por meter una excepción (un hex, un radio a mano, un azul), es señal de que el patrón que buscás ya existe con otro nombre. Volvé arriba.
