# apps/web — Design System v4

**Rule zero:** antes de crear un componente nuevo o cambiar la UI de uno existente, **lee este archivo y `apps/web/src/styles/theme.css`**. `theme.css` es la fuente única: si algo de acá contradice al CSS, gana el CSS y este archivo está desactualizado — arréglalo en el mismo cambio.

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

`--row-h` es la altura de fila del grid. Toda fila de lista, chip o control mide `--row-h` o un múltiplo; usalo también como `line-height` de los chips para que una fila de tags quede pareja.

### Radio y sombra

- Radio por token: `--radius` para cards/controles, `--radius-sm` para chips y elementos chicos. No inventes `6px`.
- Sin `box-shadow` de color. Máximo el pulso de `.live-dot`.

## Primitivas listas para reutilizar

Antes de escribir CSS nuevo, buscá acá — todas viven en `theme.css` y son globales:

- `.panel` / `.panel__header` (`--dim`) — card con header en caja alta.
- `.settings-section` + `.section-header` / `.section-head-text` / `.section-head-actions` / `.section-desc` — **la caja de una pantalla de configuración.** Es la que usan Tareas, Board, Agentes, Pipeline, Acciones, Tools, System Prompts y Repos, y por eso las ocho tienen el mismo alto de caja, el mismo `h2` y el mismo espacio hasta la primera fila. Vivía copiada `scoped` en nueve componentes hasta que las copias derivaron (radios de 8/10px que el reset pisa, dos tamaños de `h2`, tres márgenes de descripción distintos): **no la vuelvas a declarar en un componente.**
- `ui/ScopeGroup.vue` — el grupo por ámbito dentro de una de esas secciones (ver abajo).
- `.btn` + `.btn--primary` / `.btn--danger` / `.btn--destructive` / `.btn--ghost` — **usá esto en vez de reinventar `.btn-save`/`.btn-cancel` por componente.** Ver "Botones" más abajo para cuál va en cada caso.
- `.uc-label` — label en caja alta, mono, con tracking.
- `.mono` — opt-in de la familia mono en un nodo suelto.
- `.kbd` / `.kbd--primary` — pill de tecla para la barra de hints.
- `.hairline` — separador de 1px.
- `.select-row` / `.select-row--active` — fila de menú con video inverso.
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

## Checklist antes de tocar UI

- [ ] Leí `theme.css` y este archivo.
- [ ] Uso tokens, no hex ni tamaños sueltos (`grep -n '#[0-9a-fA-F]\{3,6\}' <file>` sale vacío).
- [ ] Reutilicé una primitiva (`.btn`, `.panel`, `.uc-label`, `.kbd`) en vez de reinventarla.
- [ ] Los botones usan `.btn` + variante; hay como mucho un `--primary` en la pantalla, y el destructivo va último y detrás de una confirmación.
- [ ] Radios por token; ningún `0` ni `6px` a mano.
- [ ] Las filas y chips miden `--row-h` o un múltiplo.
- [ ] No redeclaré `.settings-section` / `.section-header` / `.section-desc` en el componente.
- [ ] Si la pantalla se configura en dos ámbitos: lo propio y lo heredado están en dos `ScopeGroup`, lo heredado abre el mismo detalle, y ese detalle no ofrece guardar.
- [ ] Mono sólo en lo copiable; prosa en Sans.
- [ ] Si hay `<a>` que no es link de texto, su `:hover` redefine `background`.
- [ ] Contraste ≥ 4.5:1 en la paleta oscura.
- [ ] Los atajos de teclado están expuestos con `.kbd`.

Si estás por meter una excepción (un hex, un radio a mano, un azul), es señal de que el patrón que buscás ya existe con otro nombre. Volvé arriba.
