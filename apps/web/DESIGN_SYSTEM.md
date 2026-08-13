# apps/web — Design System v3 (console)

**Rule zero:** antes de crear un componente nuevo o cambiar la UI de uno existente, **lee este archivo y `apps/web/src/styles/theme.css`**. La app es una consola dark con paleta ANSI-16 y una sola tipografía monoespaciada. Cambios que reintroducen radios, sombras coloridas, azules corporativos o `background: #fff` rompen la coherencia visual del producto.

## Tokens (fuente única: `apps/web/src/styles/theme.css`)

### Superficies

| Var             | Uso                                            |
| --------------- | ---------------------------------------------- |
| `--bg`          | Fondo raíz de la app                           |
| `--panel`       | Cards, tablas, popovers                        |
| `--panel-alt`   | Filas alternas (zebra) o cards secundarios     |
| `--panel-hi`    | Hover, headers de panel, tab strip             |
| `--border`      | Hairlines entre celdas y bordes de card        |
| `--border-hi`   | Bordes de foco / énfasis                       |
| `--border-mute` | Separadores dentro de una lista                |

### Texto

| Var           | Nivel                       | Contraste vs `--bg` |
| ------------- | --------------------------- | ------------------- |
| `--fg`        | Primario (títulos, valores) | ~15:1               |
| `--fg-mute`   | Body copy, descripciones    | ~11:1               |
| `--fg-dim`    | Meta, labels secundarios    | ~7:1                |
| `--fg-dimmer` | Placeholders, hairlines lbl | ~4.5:1              |

Nada debe ser texto por encima de fondo con contraste < 4.5:1. Si necesitas destacar, sube un escalón; no bajes.

### Acentos ANSI

| Var         | Rol semántico                                                 |
| ----------- | ------------------------------------------------------------- |
| `--accent`  | Verde ácido. Foco, fila seleccionada, agente vivo, éxito.     |
| `--danger`  | Rojo. Errores, destructivo, validación.                       |
| `--warn`    | Amarillo. En curso, refining, spinner.                        |
| `--info`    | Cyan. Rutas, providers, worktrees, referencias.               |
| `--ai`      | Magenta. Assist, propuestas de IA, nombres de variable.       |
| `--green-bg`/`--red-bg`/`--yellow-bg` | Fondos de estados fuertes.        |

Regla: cada estado usa **una** ranura. No mezcles verde y azul como “ok primario/secundario”; no hay dos “ok”.

### Tipografía

- Familia: `var(--font-mono)` (JetBrains Mono → SF Mono → Menlo).
- Tamaños: `--fs-micro` 11px · `--fs-chrome` 12px · `--fs-body-sm` 13px · `--fs-body` 14px.
- Altura de fila: `--row-h` 22px. Toda fila de tabla, chip o input debe medir 22px o múltiplos.
- Títulos: `font-weight: 700`, `text-transform: uppercase`, `letter-spacing: var(--tracking-hd)`. Mismo tamaño que el cuerpo; jerarquía por caja alta + tracking.

### Radios y sombras

- **Radio 0.** Sin excepciones. El reset global aplica `border-radius: 0 !important`.
- **Sin box-shadow de color.** Máximo un `box-shadow: 0 0 12px -6px var(--accent)` para el pulso del chip live.

## Primitivas listas para reutilizar

- `.panel` + `.panel__header` — card con header en `--panel-hi`.
- `.uc-label` — label en caja alta con tracking.
- `.kbd` / `.kbd--primary` — pill de tecla en la barra de hints.
- `.live-dot` — 7px verde con blink.
- `.select-row` / `.select-row--active` — menú TUI con video inverso.

## Patrones de vista

- **Header de página:** un `h1` en mono uppercase (`font-size: 1.4rem`), sub-copy `--fg-mute`.
- **Sub-navegación:** vive en el sidebar como filas indentadas debajo de la sección padre (ver `SettingsSidebar.vue`, prop `children`). **No** metas tab strips arriba del contenido; la sección padre expone su árbol al hacerse activa.
- **Tabla:** grid con `grid-template-columns` medidas en `ch`, filas de 22px, hairline `--border-mute` entre filas.
- **Log/feed:** header en caja alta con timestamp/columna/dur, filas monoespacio, glifo de estado (`✓ ◐ ✕ ⊘`) coloreado por token.
- **Barra de hints:** al pie del panel, `--panel-hi` + `.kbd` con la letra + texto en `--fg-dim`. Ej: `[⏎] guardar  [esc] cancelar`.
- **Selección:** video inverso (`background: var(--accent); color: var(--panel)`); nunca outlines de color.
- **Multiselección:** prefijo `[✓]` / `[ ]` a la izquierda; el cursor sigue siendo el video inverso.

## Glifos

`●` proceso vivo · `○` proceso detenido · `◐` en curso · `✓` completado · `✕` fallo/cerrar · `▸` cursor de fila · `→` acción sugerida · `➜` prompt · `✦` salida de IA · `·` detalle secundario. Prefiere Unicode sobre íconos SVG.

## Errores

Un error no es un toast rojo. Es una línea `✕` en `--danger` con el mensaje literal del proceso y, debajo, una línea `→` en `--info` con la acción que lo resuelve. Copiable entera.

## Cómo debería verse un componente nuevo

1. Abre `theme.css` y localiza qué tokens necesitas (superficie, texto, acento).
2. Reutiliza `.panel`, `.panel__header`, `.uc-label`, `.kbd` cuando aplique.
3. Grid en `ch` si es tabla; filas de 22px.
4. Ningún hex hardcoded. Ningún radio > 0. Ningún box-shadow decorativo.
5. Verifica contraste con [WebAIM Contrast](https://webaim.org/resources/contrastchecker/) — cualquier texto ≥ 4.5:1.

## Checklist antes de tocar UI

- [ ] Leí `theme.css` y este archivo.
- [ ] Uso variables, no hex.
- [ ] Reutilicé una primitiva existente si aplicaba.
- [ ] La fila mide 22px o múltiplo.
- [ ] El estado activo usa video inverso, no un outline colorido.
- [ ] Los atajos de teclado están expuestos con `.kbd` en la barra de hints.

Si estás por meter una excepción (`border-radius`, azul, blanco, shadow decorativa), es señal de que el patrón que buscas ya existe con otro nombre en el design system. Vuelve arriba.
