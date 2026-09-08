# Handoff: ia-flow — rediseño mobile de tareas y ejecuciones

## Overview

`apps/web` (SPA Vue 3 de ia-flow) no es usable en un teléfono, y en ninguna resolución se
puede responder la pregunta más básica sobre una tarea: **¿se ejecutó o no?** Este handoff
cubre dos cosas:

1. Un **vocabulario de estado de ejecución** aplicado a toda fila de tarea, en mobile y en
   desktop.
2. Una **navegación mobile nueva**: el drawer se elimina y lo reemplaza una tab bar de cuatro
   destinos.
3. El **rediseño mobile** de cinco pantallas más una nueva (`Qué sigue`), dejando el resto
   de la app intacta.

El caso de uso que lo motivó, en palabras del usuario: *"no es tan mobile usable, y no puedo
ver una tarea porque se ejecutó o no"*.

## About the Design Files

Los archivos `.dc.html` de este bundle son **referencias de diseño hechas en HTML** —
prototipos que muestran el aspecto y el comportamiento buscado, no código de producción para
copiar. La tarea es **recrear estos diseños dentro de `apps/web`**, con sus patrones ya
establecidos: Vue 3 + `<script setup lang="ts">`, features-sliced (`src/features/<dominio>/`),
estilos `scoped` por componente usando **exclusivamente** las variables de
`src/styles/theme.css`. Nada de hex hardcodeado, nada de radios a mano, nada de CSS global
nuevo fuera de `theme.css`.

Antes de escribir una línea, leer `apps/web/DESIGN_SYSTEM.md` y `apps/web/src/styles/theme.css`.
Los prototipos usan estilos inline con los valores literales de esos tokens **solo porque el
formato del prototipo lo exige**; en el código real cada uno de esos hex debe volver a ser su
`var(--…)`. La tabla de la sección "Design Tokens" da la traducción exacta.

## Fidelity

**Alta fidelidad.** Colores, tipografía, tamaños, alturas táctiles y copy son finales. Los
prototipos están dibujados a 390×800 (mobile) y 1280 de ancho (desktop) con los tokens reales
del repo. Recrear la UI fielmente reusando las primitivas que ya existen (`.btn` y sus
variantes, `.panel`, `.settings-section`, `.uc-label`, `.kbd`, `.live-dot`, `.live-toggle`,
`ui/EditableCard.vue`, `ui/FilterQueryInput.vue`, `components/TaskTags.vue`) en vez de
reinventarlas.

El copy es en español rioplatense, en minúsculas para los datos mono y en caja alta con
tracking para los encabezados de sección. Mantenerlo literal.

---

## El vocabulario de estado de ejecución

Es la pieza central y la única que toca casi todas las pantallas. Seis estados, una sola
línea por tarea, siempre en el mismo orden de lectura: **glifo · qué pasó · agente · duración**.

| Estado | Glifo | Color del glifo/línea | Ejemplo literal | De dónde sale |
| --- | --- | --- | --- | --- |
| corriendo | cuadrado 7×7 con blink (`.live-dot`) o `◐` | `--accent` | `◐ implementer · paso 3/5 · escribiendo tests` + `4m 12s` | `ExecutionLog.finishedAt == null` |
| falló | `✕` | `--danger` | `falló en tests · hace 2 h · 2 intentos` + `6m 40s` | `outcome === 'error'`, `failureClass`, `errorMsg` |
| terminó | `✓` | `--accent` (texto en `--fg-mute`) | `✓ terminó hace 19 h · PR #1233 abierto · CI ✓` | `outcome === 'success'`, `durationMs` |
| sin ejecutar | `○` | `--fg-dimmer` | `sin ejecutar · sin rama · sin PR` | cero filas en `execution_logs` para esa tarea |
| ignorada | `○` | `--warn` | `ignorada · ninguna regla matcheó su status` | `GET /api/tasks/:id/run-preview` |
| bloqueada | `⛔` | `--warn` | `⛔ nunca se ejecutó · bloqueada por #1236` | `ITaskSource.getBlockers` |

Dos reglas que no se ven en la tabla:

- **Un `✕` nunca aparece sin el motivo literal al lado.** El error es una línea `✕` en
  `--danger` con el mensaje del proceso y, debajo, una línea `→` en `--info` con la acción
  que lo resuelve. Copiable entera. (Es la regla de errores que ya está en `DESIGN_SYSTEM.md`.)
- **Un "no sé" no se dibuja como "no hay".** Si el dato no llegó, la línea no se pinta. Solo
  se afirma `sin PR` / `sin rama` cuando el provider modela PRs (`pullRequestsKnown`,
  `devLinks` — misma convención que ya usa `components/TaskTags.vue`).

Componente a crear: **`src/components/ExecutionStatusLine.vue`** (en `components/` y no en una
feature porque lo comparten `features/tasks`, `features/statuses` y `features/executions`; los
tipos que recibe cruzan el wire, así que vienen de `@ia-flow/shared`).

Props: `{ execution?: ExecutionLog | null, blocked?: boolean, ignoredReason?: string | null,
pullRequestsKnown?: boolean }`. Un solo punto decide qué estado se pinta, en este orden:
corriendo → falló → terminó → bloqueada → ignorada → sin ejecutar.

---

## Screens / Views

### 0. Navegación mobile — se elimina el drawer

**Componentes:** `src/views/AppShell.vue` (nuevo pie), `src/components/SettingsSidebar.vue`
(se limita a ≥ 768px), `src/features/projects/ProjectSwitcherSheet.vue` (nuevo),
`src/views/MoreView.vue` (nuevo)
**Referencia:** frames `4a`, `4b`, `4c` de `Mobile IA-Flow.dc.html`
**Propósito:** bajo 768px, el drawer desaparece. La tab bar tiene que llegar a las 30 pantallas
de la app, no solo a cuatro — eso obliga a tres decisiones que hay que respetar juntas o no
funciona ninguna.

#### La tab bar

Cuatro destinos fijos, `display: grid; grid-template-columns: repeat(4, 1fr)`, cada celda de
**60px** de alto, borde superior `--border`, fondo `--panel`. Por celda: glifo (14px) y
etiqueta debajo (mono **10px**, caja alta, `letter-spacing: .06em`, `gap: 4px`).

| Tab | Glifo | Ruta | Notas |
| --- | --- | --- | --- |
| QUÉ SIGUE | `✦` | `/projects/:id/que-sigue` | entrada por defecto del proyecto en mobile |
| TAREAS | `▤` | `/projects/:id/tareas` | incluye Board como vista |
| RUNS | `●` | `/projects/:id/executions` | punto vivo cuando hay algo corriendo |
| MÁS | `☰` | `/mas` | índice completo de la app |

El tab activo va en `--accent` con la etiqueta en `font-weight: 700` y una **barra superior de
2px** (`box-shadow: inset 0 2px 0 var(--accent)`) — no un fondo relleno, que a 60px pesa
demasiado. Los inactivos en `--fg-dim`.

**El badge de RUNS es un punto, no un número**: 6px, `border-radius: 50%`, `--accent`, con
`blink 1.6s`, posicionado sobre el glifo (`position: absolute; top: 12px; left: calc(50% + 9px)`).
El conteo ya está dentro de la pantalla; acá solo importa el binario *hay algo corriendo / no hay*.
Si el socket está caído, el punto no se pinta — nunca un punto quieto que insinúe actividad.

Los tres primeros tabs son **relativos al proyecto activo**: cambiar de proyecto mantiene el tab.

#### Board deja de ser destino propio

Cuatro tabs es el techo con etiquetas legibles a 390px; el quinto habría entrado a costa de
abreviar. Board es la misma lista de tareas agrupada de otra forma, así que pasa a ser un
**toggle segmentado dentro de Tareas**: dos celdas de 40px (`flex: 1`) con `Lista` / `Board`,
la activa en video inverso (`--accent` de fondo, `--panel` de texto, `font-weight: 700`).
Va arriba de los chips de filtro. La ruta `/projects/:id/board` sigue existiendo y sigue siendo
válida — el toggle navega a ella; en mobile la renderiza el mismo componente de sección.

#### El proyecto sube al header

El drawer mezclaba dos preguntas distintas: *en qué proyecto estoy* y *a qué pantalla voy*.
Se separan: la tab bar es la pantalla, el header es el proyecto.

Header de 44px, presente en las tres pantallas de trabajo: bloque tappable a la izquierda con
el slug en mono `--info` y debajo una línea de meta en mono `--fs-micro` `--fg-dimmer`
(`42 tareas · 2 corriendo`), cerrado por un `⌄`; a la derecha un ícono de 44×44 (`⌕`).

**`ProjectSwitcherSheet`** (`4c`) es el mismo bottom sheet que `FilterSheet` —
`translateY(100%) → 0` en 150ms, backdrop `rgba(0,0,0,.6)` que cierra al tocar,
`border-radius: 12px 12px 0 0`, borde superior `--border-hi`. Filas de **52px**: glifo de
estado del proyecto · slug en mono 13px · meta en mono `--fs-micro`. El proyecto actual va en
video inverso con `▸`. **Cada fila trae el estado agregado del proyecto** (`2 corriendo`,
`2 fallos sin atender` en `--danger`, `nada corriendo`, `archivado`) — es lo que permite ver
dónde hay fuego sin entrar. Al pie, `⇄ Cambiar de server` (48px, neutro).

#### La pantalla Más — `/mas` (nueva)

Es el índice completo, y el único camino a las 23 pantallas que el drawer cubría. Nada se
vuelve inalcanzable.

Grupos con `.uc-label` y filas de **48px** (`gap: 11px`): columna de glifo de 14px, etiqueta
Sans 14px (`flex: 1`), contador o estado en mono `--fs-micro`, y `›` en `--fg-dimmer`.

- **Proyecto · <slug>** — `⎇ Repos y ramas`, `⛭ Pipeline y reglas` (con el conteo de reglas en
  `--warn`), `✦ Agentes`, y una última fila que colapsa las cinco tabs restantes:
  `Overview, prompts, provider, acciones, tools`.
- **Server** — `▦ Dashboard` (con `3 fallos` en `--danger` si los hay), `● Todas las ejecuciones`,
  `▤ Proyectos`, `⛭ Configuración general` (`11`), `▧ Logs del daemon`, `▨ Agent host` (`remoto`).
- **`⇄ Cambiar de server`** en su propio grupo.
- Pie de estado: `.live-dot` + `conectado · prod-01 · rate limit 62%` en mono `--fs-micro`
  `--fg-dimmer`.

Los contadores no son decoración: son la única señal de que hay algo que mirar en una pantalla
a la que ahora se llega en tres toques en vez de dos.

#### Lo que se pierde, dicho explícitamente

Llegar a una sección de configuración pasa de dos toques a tres (Más → grupo → sección), y el
árbol de proyecto expandido deja de existir. A cambio, las tres pantallas de trabajo diario
quedan a un toque desde cualquier lugar.

#### Reglas de implementación

- **`SettingsSidebar.vue` no se borra**: se envuelve en `@media (min-width: 768px)`. Sobre
  768px la app no cambia en nada y la tab bar no se renderiza (`v-if` sobre el media query, no
  `display: none` — no montar un pie que nadie va a ver).
- **El estado `drawerOpen` y el backdrop desaparecen** de la ruta mobile. Ningún `☰` en el
  header abre nada: el `☰` ahora es el tab `Más` y navega.
- **Contenido con `padding-bottom: 60px`** (el alto de la tab bar) para que la última fila de
  una lista no quede tapada. En pantallas con barra de acciones fija (el detalle de tarea),
  **la barra de acciones reemplaza a la tab bar**: el detalle es pantalla completa, tiene `←`
  y no muestra tabs — si mostrara las dos barras, 108px del alto se irían en chrome.
- **La tab bar no aparece** en el detalle de tarea, en `/servers`, ni en `/agent-host`
  (esta última tiene su propio contexto y credencial).
- **Volver desde un tab** vuelve al scroll y a los filtros con que se dejó ese tab. Cada tab
  mantiene su propia posición.

### 1. Tareas — `/projects/:id/tareas` (rediseñada)

**Componente:** `src/features/tasks/TareasSection.vue`
**Propósito:** ver de un barrido qué está corriendo, qué falló y qué no arrancó nunca; filtrar; abrir una.

**Mobile (< 768px)**

Layout, de arriba a abajo, todo en una columna de `padding: 0 16px`:

1. **Header de sección.** `←` de 44×44 + título `Tareas` (`--font-display`, 16px, caja alta,
   `letter-spacing: .12em`) + contador `6 de 42` a la derecha (mono, `--fs-micro`, `--fg-dim`).
2. **Fila de chips de vistas guardadas.** Scroll horizontal, `gap: 6px`, cada chip de **40px**
   de alto, `padding: 0 12px`, `border-radius: var(--radius-sm)`, mono 12px, `white-space: nowrap`.
   Activo: relleno `--accent` con texto `--panel`. Inactivo: `--panel-hi` con borde `--border-hi`
   y texto `--fg-mute`. Los chips llevan su contador y su glifo de estado:
   `me toca 4`, `✕ falló 2`, `⛔ bloq. 2`, `filtrar…`.
   El chip parcialmente cortado en el borde derecho es la señal de scroll — es intencional.
3. **Input de query.** 44px de alto, `--panel`, borde `--border`, mono 12px. Es
   `ui/FilterQueryInput.vue` tal cual, con los mismos campos que ya declara
   `TaskFiltersBar.vue` (`status`, `repo`, `asignado`, `pr`, `rama`, `bloqueada`).
   Tokens ya aplicados se ven como `status:` en `--fg` seguido de su valor en `--info`.
4. **Lista.** Filas separadas por hairline `--border-mute`, zebra alternando `--panel` /
   `--panel-alt`. Cada fila es un `grid-template-columns: 20px 1fr` con `gap: 10px`,
   `padding: 10px 16px`:
   - columna 1: el glifo de estado (o el `.live-dot`, con `margin-top: 6px` para alinear con
     la primera línea de texto);
   - columna 2: título (Sans 14px, `line-height: 1.4`, **`text-wrap: pretty`, envuelve, nunca
     trunca**) con el `#1240` en mono `--fs-micro` `--fg-dimmer` a su derecha, y debajo la
     `ExecutionStatusLine` (mono `--fs-micro`, esta sí trunca con ellipsis).

**Desktop (≥ 768px)** — ver `3a` en `Mobile IA-Flow.dc.html`

La fila vuelve a una sola línea: `grid-template-columns: 16px minmax(0,1fr) 7ch 13ch 11ch 7ch`
con `gap: 12px` y altura de 30px — columnas *tarea · issue · ejecución · agente · duración*
(la última alineada a la derecha). Encabezado de tabla de 26px en `--panel-hi`, mono
`--fs-micro`, caja alta. Fila seleccionada en **video inverso** (`background: var(--accent);
color: var(--panel)`), nunca outline de color. Al pie, barra de atajos de 26px con `.kbd`:
`↑↓ navegar`, `↵ abrir` (en `.kbd--primary`), `r reintentar`.

Los chips de vistas guardadas y el input de query van en **la misma fila** (los chips a
`height: 26px`, el input con `flex: 1; min-width: 200px`).

### 2. Detalle de tarea — `/projects/:id/tareas/:taskId` (rediseñada)

**Componentes:** `src/features/tasks/TaskDetailModal.vue`, `src/features/tasks/TaskExecutions.vue`
**Propósito:** entender qué pasó con esta tarea y actuar sin salir.

Misma estructura en los tres estados —encabezado, tarjeta de estado, timeline, historial,
acciones—; lo que cambia es qué tiene contenido y cuál es la acción principal.

**Mobile: pantalla completa, no modal centrado.**

- **Header** de 44px: `←` (44×44) · `#1240` en mono `--fg-dim` · `↗` a GitHub (44×44).
  Borde inferior `--border-mute`.
- **Título** Sans 19px `font-weight: 600`, `line-height: 1.3`, `text-wrap: pretty`.
- **Fila de tags**: `components/TaskTags.vue` sin cambios (repos, rama, PR con su CI, slack).
- **Tarjeta de estado**: `border-radius: var(--radius)`, borde `--border` y **borde izquierdo
  de 2px con la ranura del estado**; fondo `--green-bg` / `--red-bg` / `--yellow-bg` según el
  caso, o `--panel` cuando está corriendo. Contiene: la línea de estado en 14px, la meta en
  mono `--fs-micro` (`implementer · anthropic-api · sonnet · arrancó 9:37`), y —solo mientras
  corre— el **tail de dos líneas** del log sobre `--bg` con borde `--border-mute`, la última
  línea en `--fg` cerrada por `.cursor-block`.
- **Timeline** (`RunTimeline`, ver abajo).
- **Historial**: una fila de 44px, mono 12px `--info`: `⌄ Ejecución 1 · falló igual · hace 5 h`.
- **Barra de acciones fija al pie**: borde superior `--border`, fondo `--panel`,
  `padding: 12px 16px 16px`, `gap: 8px`, botones de **48px**.

Acción principal por estado:

| Estado | Barra de acciones |
| --- | --- |
| terminó | `Ver PR #1233` (primary, `flex: 1`) · `Logs` · `Correr` |
| corriendo | `Ver logs en vivo` (neutro, `flex: 1`) · `Abortar` (`.btn--danger`) — **no hay primary**: no hay nada que iniciar |
| falló | `Reintentar` (primary, `flex: 1`) · `Logs` · `Abortar` |
| sin ejecutar / ignorada | `Correr ahora` (primary, `flex: 1`) · `Cambiar status` |

**Desktop: panel lateral de 400px a la derecha de la lista**, no modal — la lista no se
pierde al abrir una tarea. Header de 30px en `--panel-hi` con `#1240`, `↗ github` y `✕`.
Las acciones van en un pie de panel de 50px con botones de 30px, en el orden
neutro → primario → peligroso, con el `Abortar` empujado a la derecha por un `flex: 1`.

#### `RunTimeline` — `src/features/tasks/RunTimeline.vue`

`grid-template-columns: 18px 1fr` con `gap: 10px` por paso. Columna izquierda: el glifo del
paso (`✓` `--accent`, `✕` `--danger`, `○` `--fg-dimmer`, o el `.live-dot` para el paso en
curso) y, debajo, un rail de 1px en `--border` que estira (`flex: 1`) hasta el paso siguiente
— el último paso no lleva rail. Columna derecha, con `padding-bottom: 12px`: nombre del paso
(Sans 14px) con su duración a la derecha (mono `--fs-micro` `--fg-dim`), y debajo una o dos
líneas de meta en mono `--fs-micro` (`bun run test · exit 1`, `+64 −12`, `PR #1233 · status → In review`).
El paso que falló lleva su nombre en `--danger` y su meta con el conteo real
(`3 failed, 128 passed`). Los pasos que no llegaron a correr van en `--fg-dim` con
`pendiente` / `no llegó` en `--fg-dimmer`.

> **Este componente depende de datos que el server hoy no tiene.** Ver "Requisitos de backend".

### 3. Por qué no corre / está ignorada (nueva vista dentro del detalle)

**Componente:** `src/features/tasks/RunPreviewCard.vue`
**Propósito:** contestar "¿por qué esta tarea está siendo ignorada?" — hoy la única huella es
una línea `Rules NOT matched` en el `daemon.log`.

Reemplaza el timeline cuando la tarea nunca corrió. Estructura:

1. Tarjeta de estado en `--yellow-bg`: `○ Nunca se ejecutó` + `Ninguna regla matcheó su status ·
   3 evaluadas · 14 no aplican` (mono `--fs-micro` `--fg-dim`).
2. Encabezado `Por qué se está ignorando` (`.uc-label`).
3. **Una card por regla descartada** (`--panel`, borde `--border`, `--radius`, `padding: 11px 13px`,
   `gap: 8px`): nombre de la regla (Sans 14px) + el motivo del descarte en mono `--fs-micro`
   `--warn` a la derecha (`when`, `apagada`, `exclusive`). Debajo, **una fila por condición que
   falló**, en mono `--fs-micro`:
   `campo` en `--fg` · operador en `--fg-dim` · valor esperado en `--info` · *(spacer)* · **valor
   real de la tarea en `--danger`**. Cuando el evento no trae ese campo, el valor real es
   `sin valor` en `--fg-dimmer` — es el error de config más común y tiene que leerse distinto
   de "trae otro valor".
   Cierra con la línea de acción `→ Mover a Refining o poner la label` en `--info`.
4. Una regla apagada no muestra condiciones: muestra `deshabilitada en este proyecto` y
   **dónde sí se edita** (`→ Se edita en General → Pipeline`). Sin esa línea, "no se puede" es
   un callejón sin salida — misma regla que los `ScopeGroup` heredados.

Mapeo directo desde `TaskRunPreview` (`packages/shared/src/schemas.ts`):
`blockedReason` → la tarjeta; `rejected[]` → las cards; `rejected[].reason` → el badge;
`rejected[].failed[].field/op/value/actual` → las filas de condición; `notApplicable` → el
contador `14 no aplican`; `matched[]` → si tiene algo, la tarea sí correría y esta vista no aplica.

### 4. Qué sigue — `/projects/:id/que-sigue` (nueva)

**Componente:** `src/features/tasks/NextUpSection.vue`
**Propósito:** entrada por defecto del proyecto en mobile. Decidir qué tocar ahora.

- **Header**: título `Qué sigue` + subtítulo mono `--info` (`lahaus/subscriptions · 42 tareas`)
  + `.live-toggle` a la derecha.
- **Resumen IA colapsado en una línea**: card `--panel` con borde izquierdo de 2px en `--ai`,
  glifo `✦` en `--ai`, texto 13px `--fg-mute` con lo importante en `--fg`
  (`Un solo cuello de botella: PR #1236 traba 4 tareas.`) y un `⌄` para expandir.
  En desktop la línea es más larga y ocupa el ancho completo.
- **Cola priorizada**: `Cola priorizada` (`.uc-label`) con `orden IA` a la derecha en
  `--fg-dimmer`. Filas de `grid-template-columns: 22px 1fr`, `gap: 10px`, separadas por
  hairline, sin zebra. Columna 1: el número de puesto en mono 12px — `--accent` para los
  primeros tres (accionables ahora), `--fg-dim` para el resto. Columna 2: título · `#issue`
  · **la razón del puesto** en mono `--fs-micro` con el color de su estado · la acción
  sugerida `→ Aprobar y mergear` en `--info`.
  La razón es lo que distingue esta pantalla de un listado ordenado por fecha: siempre dice
  *por qué* está ahí (`CI ✓ · esperando review 22 h · desbloquea 4`,
  `✕ falló 2 veces en tests · no reintenta solo`, `⛔ bloqueada por #1236 · nunca se ejecutó`).
- **Pie**: `ver las 42 tareas →` (48px, mono 12px `--info`).
- **Header de proyecto** de 44px arriba (ver sección 0) y **tab bar** de 60px al pie, con
  `QUÉ SIGUE` activo. Esta pantalla es el destino por defecto del proyecto en mobile.

En desktop (`3b`) la cola va a la izquierda con la razón y la acción en columnas propias
(`22px minmax(0,1fr) 20ch 24ch`), y a la derecha una columna de 330px con los runs en vuelo y
los terminados de hoy.

### 5. Runs / Ejecuciones — `/projects/:id/executions` y `/general/ejecuciones` (rediseñada)

**Componente:** `src/features/executions/ExecutionsSection.vue` (105 KB — extraer subcomponentes
dentro de la feature al tocarlo, como pide `apps/web/CLAUDE.md`)

- **En vuelo**: una card por run (`--panel`, borde izquierdo 2px `--accent`): `.live-dot` +
  título + duración en `--warn`; meta mono (`#1244 · implementer · anthropic-api · sonnet`);
  **barra de pasos** — N segmentos de `height: 4px` y `border-radius: 2px` en `flex: 1`,
  `--accent` los completados, `--warn` el actual, `--border` los pendientes, con `3/5` en mono
  al final; tail de log de dos líneas; y `Ver logs` + `Abortar` de 44px.
- **Terminados hoy**: lista compacta de filas de 44px con glifo de outcome, título truncado,
  meta mono (`reviewer · 2m 05s · PR mergeado`) y edad relativa a la derecha.

### 6. Board — `/projects/:id/board` (rediseñada)

**Componente:** `src/features/statuses/StatusesSection.vue`

**Ya no es un destino de la tab bar**: se llega por el toggle `Lista / Board` de Tareas
(sección 0). La ruta `/projects/:id/board` sigue siendo válida.

**Una columna por vez, no un carrusel horizontal.** Los status son chips de 40px con su
contador (`Backlog 21`, `In progress 6`, `In review 4`, `Done`) en scroll horizontal; el
activo en video inverso. Debajo, el encabezado de la columna elegida (`In progress · 6`) con
un contador de atención a la derecha en `--warn` (`2 sin agente`), y la misma lista densa de
Tareas. Arrastrar entre columnas no existe en mobile: se cambia el status desde el detalle.

### 7. Dashboard — `/dashboard` (rediseñada)

**Componente:** `src/views/DashboardView.vue`

- **Cuatro contadores** en `grid-template-columns: 1fr 1fr`, `gap: 8px`. Cada card: `.uc-label`
  arriba y el número en mono **24px** con el color de su ranura — `corriendo` en `--accent`,
  `fallaron hoy` en `--danger`, `ignoradas` en `--warn`, `espera review` en `--fg`.
  Las `ignoradas` son nuevas y son el número que hoy nadie ve.
- **Salud por agente** (24 h): filas de 44px con `agentId` en mono `--fg`, corridas, `p50` y
  el porcentaje de éxito alineado a la derecha en `width: 4ch` — `--accent` ≥ 80%, `--warn`
  entre 50 y 80, `--danger` por debajo. Sale de `GET /api/executions/stats`, que ya existe.
- **Patrón de fallo del día**: card `--red-bg` con `✕ 2 de los 3 fallos de hoy son el mismo
  paso de tests` y `→ Ver #1240 y #1246`.
- **Rate limit**: fila de 44px con `62% · resetea 10:20` (ya existe como
  `components/RateLimitChip.vue` / `RateLimitBanner.vue`).

### Pantallas que NO se tocan

No borrar ni migrar nada de esto. Sobre 768px sigue llegándose por el sidebar de siempre; bajo
768px, por la pantalla `Más` (sección 0). Ninguna queda inalcanzable:

- `/servers` (`ServerPickerView.vue`) y `/projects` (`ProjectsListView.vue`) — ya son listas
  de una columna y funcionan en mobile hoy.
- Las 8 tabs de configuración del proyecto: `overview`, `repos`, `provider`, `system-prompts`,
  `agentes`, `pipeline`, `acciones`, `tools`.
- Las 11 secciones de `/general/:tab`: `agentes`, `pipeline`, `system-prompts`, `providers`,
  `acciones`, `tools`, `mcp-catalog`, `entorno`, `escaneo`, `aborted-runs`, `logs`.
- `/agent-host` y `/agent-host/logs` — otro proceso y otra credencial, fuera de alcance.

---

## Interactions & Behavior

- **Abrir una tarea.** Mobile: navegación a pantalla completa, `←` vuelve a la lista con el
  scroll y los filtros intactos. Desktop: se abre el panel lateral; la fila queda en video
  inverso; `Esc` o `✕` lo cierran.
- **Reintentar.** `POST /api/tasks/:id/run` con `{ projectId }`. La respuesta trae
  `outcome: 'dispatched' | 'skipped' | 'deferred'` y hay que distinguirlos en el toast:
  *despachado*, *ninguna regla matcheó tu status* (config para revisar, no un error del server)
  y *en cola por capacidad*. Al volver, recargar los runs de la tarea (`TaskExecutions.vue` ya
  tiene el `reloadToken` para eso).
- **Abortar.** `POST /api/executions/:id/cancel`. Cuatro ramas a reflejar en el toast, todas
  ya en la respuesta: cancelado en vuelo, huérfano limpiado, `alreadyFinished` (no-op) y
  `cancelRequested` — este último es un aviso al daemon dueño del run: **el contenedor sigue
  corriendo**, y decir "abortado" ahí sería mentir. Confirmación previa siempre.
- **Live.** `useServerEvents` con `execution:started`, `execution:updated`, `task:updated`.
  El `.live-toggle` ya tiene los tres estados (apagado, conectado pulsando en `--accent`,
  reconectando pulsando en `--warn`). Sin socket, la duración de un run en vuelo sigue
  corriendo en el cliente desde `startedAt` (no congelarla).
- **Filtros.** Un único modelo de estado: los chips, el bottom sheet y la query escriben el
  mismo `TaskFilters` de `features/tasks/taskFilters.ts` (vacío = sin restricción; OR dentro
  de un eje, AND entre ejes). Se serializa al querystring con `taskFiltersToQuery` y al
  `localStorage` con `taskFiltersToSearch`, que ya existen. Una vista guardada es un
  `TaskFilters` con nombre, nada más.
- **Bottom sheet** (`ui/FilterSheet.vue`): entra con `transform: translateY(100%) → 0` en
  `150ms ease` (mismo timing que el drawer del sidebar), borde superior `--border-hi`,
  `border-radius: 12px 12px 0 0`, backdrop `rgba(0,0,0,.6)` que cierra al tocarlo. Al pie,
  `Ver N tareas` (primary) + `Guardar vista`. El contador del botón se actualiza en vivo
  mientras se togglean chips.
- **Transiciones.** Solo las que ya usa el tema: `border-color / background / color` a `.12s`
  en `.btn`, `120ms` en `.live-toggle`, `blink 1.6s ease-in-out infinite` en el punto vivo.
  Nada nuevo, ninguna sombra de color.
- **Cambiar de proyecto.** El sheet navega al **mismo tab** en el proyecto nuevo
  (`/projects/:otroId/tareas`), no a la raíz. Cierra con la misma transición de 150ms.
- **Foco.** Marcar la fila navegable con `[data-kbd-item]` y dejar que `theme.css` pinte el
  foco; no escribir un `:focus-visible` propio. `useKeyboardNav` ya maneja `↑↓`/`↵`.
- **Trampa conocida.** `theme.css` define `a:hover { background: var(--accent) }`. Todo `<a>`
  que sea un chip, un tag o una fila clickeable **tiene que redefinir `background` en su
  `:hover`**; pisar solo `color` lo deja pintado de teal entero.

## State Management

Nada nuevo a nivel global. Por feature:

- `features/tasks/` — el filtro vive donde ya vive (`taskFilters.ts` + query + localStorage).
  `blocked` se resuelve fuera del módulo de filtros y llega como campo del row.
- `features/executions/activeStore.ts` — ya mantiene los runs en vuelo; es la fuente del
  contador del topbar, de la sección `Corriendo` y de la columna derecha de Qué sigue.
- El resumen y el orden de la cola: un `ref` en `NextUpSection.vue` con la respuesta del
  endpoint nuevo, más un timestamp `hace 2 min`. No hace falta store: vive y muere con la
  pantalla.
- Todo fetch va por el `api.ts` de su feature con `.parse()` de la respuesta. Cero `axios.`
  o `fetch(` en un `.vue`. Cero imports entre features (si dos la necesitan, sube a `ui/`,
  `composables/` o `@ia-flow/shared`).

## Requisitos de backend

Lo que ya existe y alcanza para casi todo:

- `GET /api/executions?projectId&taskId&limit` · `GET /api/executions/active` ·
  `GET /api/executions/stats` y `/stats/:agentId`
- `GET /api/tasks/:id/run-preview` — **la explicación de "por qué está ignorada", ya resuelta
  en el server**
- `POST /api/tasks/:id/run` · `POST /api/executions/:id/cancel`
- El WebSocket de `execution:*` / `task:updated`
- `Task.pullRequests[]` con `state`, `isDraft`, `ci`, `files`; `Task.branch`, `assignees`, `labels`

Lo que falta y hay que agregar:

1. **Agregado de último run por tarea.** Hoy `/api/executions` filtra por un `taskId`; un
   listado de 40 filas serían 40 requests. Hace falta un endpoint que devuelva el último run
   (y el conteo de intentos) de todas las tareas de un proyecto — un `GROUP BY task_id` en SQL.
   **Sin esto no se puede pintar `○ sin ejecutar`, que es el estado que motivó todo el rediseño.**
2. **Blockers en batch.** `getBlockers` existe pero la web lo resuelve item por item; mismo
   problema, misma solución.
3. **Resumen y orden de la cola.** La infraestructura para llamar al modelo ya está
   (`AssistWithAiUseCase`, `POST /api/agents/assist`, y el uso directo de Haiku en
   `application/branch-namer.ts`). Falta un caso de uso que resuma el proyecto y ordene la
   cola. Mientras no exista: ordenar en el cliente por severidad (falló → bloqueada →
   corriendo → ignorada → resto) y **no mostrar la card del resumen** en vez de inventar un
   texto.
4. **Pasos dentro de un run.** `execution_logs` guarda una fila por run, no pasos. `RunTimeline`
   y todo `paso 3/5` dependen de esto: o se derivan de los server-logs del run, o se persisten
   eventos de paso. Es el ítem más caro del handoff. **Degradación honesta mientras no exista:**
   mostrar la fila del run —outcome, agente, provider, duración y motivo, que es lo que hoy
   pinta `TaskExecutions.vue`— y omitir el timeline y el `N/M`. No falsear pasos.
5. **Aprobar / mergear un PR** desde la app. Hoy solo existe `POST /api/tasks/:id/slack-review`
   (pedir review). Mientras no exista, la acción sugerida `→ Aprobar y mergear` debe abrir el
   PR en GitHub (`↗`), no prometer un botón que no hace nada.

## Design Tokens

Todos ya en `src/styles/theme.css` — **usar la variable, nunca el hex**. Esta tabla es solo
para traducir los prototipos:

| Hex en el prototipo | Variable | Uso |
| --- | --- | --- |
| `#0f1113` | `--bg` | fondo raíz, fondo del tail de log |
| `#17191c` | `--panel` | cards, filas, barras |
| `#1c1e22` | `--panel-alt` | zebra, pie de panel |
| `#22252a` | `--panel-hi` | chip inactivo, header de tabla, botón neutro |
| `#2c2f34` | `--border` | hairlines y bordes de card |
| `#3d4148` | `--border-hi` | borde de botón neutro, borde del sheet |
| `#1e2024` | `--border-mute` | separador dentro de una lista |
| `#ece9e2` | `--fg` | títulos y valores |
| `#b5b1a7` | `--fg-mute` | body, descripciones |
| `#85817a` | `--fg-dim` | meta, labels |
| `#5c5952` | `--fg-dimmer` | ausencia, placeholders, `#issue` |
| `#7fb8ac` | `--accent` (`--green`) | vivo, éxito, foco, primary |
| `#9ecfc4` | `--green-hi` | hover del primary |
| `#e0665c` | `--danger` (`--red`) | fallo, destructivo |
| `#d9a441` | `--warn` (`--yellow`) | en curso, ignorada, bloqueada |
| `#6fbfc4` | `--info` (`--cyan`) | repo, rama, ruta, acción sugerida |
| `#c98ecb` | `--ai` (`--magenta`) | salida de IA, PR mergeado |
| `#16211f` / `#241716` / `#241f14` | `--green-bg` / `--red-bg` / `--yellow-bg` | fondos de estado |

Tipografía — tres roles, ya cargados por `theme.css`:

- `--font-display` (IBM Plex Sans Condensed) — `h1`–`h6` y kickers. Caja alta con
  `letter-spacing: var(--tracking-hd)` (`.14em`). La jerarquía la da la caja alta y el
  tracking, no el tamaño.
- `--font-body` (IBM Plex Sans) — prosa, botones, títulos de tarea, descripciones.
- `--font-mono` (IBM Plex Mono) — **solo lo que el usuario podría copiar y pegar**: `#1240`,
  `fix/sms-add-sid`, `6m 40s`, `bun run test`, ids, paths, y los labels de `.uc-label`.

Escala: `--fs-micro` (.6875rem) · `--fs-chrome` (.75rem) · `--fs-body-sm` (.8125rem) ·
`--fs-body` (.875rem), todo colgando de `html { font-size: 18px }`. El `24px` de los
contadores del dashboard es el único tamaño fuera de la escala; declararlo como `1.35rem`.

Métricas: `--row-h: 1.375rem` (grid interno de fila y `line-height` de los chips) ·
`--chrome-h: 2.25rem` (alto de la barra del `AppShell`; los overlays fijos que van por debajo
usan el mismo número para su `top`) · `--radius: 4px` · `--radius-sm: 3px` (chips y elementos
chicos). Sin `box-shadow` de color en ningún lado.

Alturas táctiles (lo único nuevo de esta capa): **48px** el botón principal de la pantalla y
las filas de la barra de acciones · **44px** toda fila navegable, botón secundario e ícono de
header · **40px** un chip de filtro. El grid de `--row-h` sigue gobernando el interior de la
fila; lo que crece es su caja.

Breakpoints: los dos que la app ya usa — **768px** (bajo ese ancho el sidebar no se renderiza y
manda la tab bar; sobre ese ancho, al revés) y **640px** (el header del proyecto se apila,
`ProjectDetailView.vue`). No agregar un tercero.

## Assets

Ninguno. Todos los glifos son Unicode, como pide `DESIGN_SYSTEM.md` ("preferí Unicode sobre
íconos SVG"): `●` proceso vivo/abierto · `○` detenido/sin correr · `◐` en curso ·
`✓` completado/mergeado · `✕` fallo/cerrado · `⛔` bloqueado · `⎇` rama · `▸` cursor de fila ·
`→` acción sugerida · `↗` abre afuera · `✦` salida de IA · `·` detalle secundario ·
`⌄` expandir · `⌕` buscar · `☰` menú.

Las fuentes ya las importa `theme.css` desde Google Fonts.

## Files

- `Mobile IA-Flow.dc.html` — los prototipos. Cuatro turnos, el más nuevo arriba:
  - **turno 4** (`4a`, `4b`, `4c`): la navegación sin drawer — Tareas con tab bar y toggle
    Lista/Board, la pantalla Más, y el selector de proyecto.
  - **turno 3** (`3a`, `3b`): desktop a 1280px — Tareas con panel de detalle, y Qué sigue.
  - **turno 2** (`2a`, `2b`, `2c`): el detalle de tarea en sus tres estados — terminada,
    corriendo, sin ejecutar.
  - **turno 1** (`1a`, `1b`): las dos direcciones mobile que se exploraron. **`1b` es la
    elegida** — cola de decisión, vistas guardadas, densidad de consola, y su cuarta pantalla
    `Por qué no corre`. `1a` queda como registro de la alternativa descartada (entrada por
    panel de estado con tab bar); no implementarla.
- `Design System Mobile.dc.html` — el sistema y el mapa completo de las 30 pantallas de la app,
  con cuáles se rediseñan, cuál es nueva y cuáles no se tocan.
- `support.js` — runtime que necesitan los dos archivos anteriores para abrirse en el browser.
  No es parte del diseño.

Los dos `.dc.html` se abren directo en un navegador. En `Mobile IA-Flow.dc.html` los frames
están anotados con `data-screen-label` (`1b · Tareas`, `2a · Detalle terminada`, …) para poder
referirse a cada pantalla sin ambigüedad.
