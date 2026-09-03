import type { ServerLogEntry, ServerLogLevel } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The section only talks to its own `api.ts` on mount, plus `useRoute` for the
// deep-link hydration. Stub both so the pills render without a live backend.
const LEVELS: ServerLogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
// Espeja COLUMNS_STORAGE_KEY del componente — bumpeada a :v3 porque cambió
// el FORMATO de los paths de extras (ver el comentario ahí).
const COLUMNS_KEY = 'ia-flow:server-logs:columns:v3'
// Espeja COLUMN_WIDTHS_STORAGE_KEY del componente.
const COLUMN_WIDTHS_KEY = 'ia-flow:server-logs:column-widths:v1'

// Repetido tal cual dentro del factory de abajo (no se puede referenciar un
// const de afuera: `vi.mock` se hoistea por encima de esta declaración,
// mismo motivo por el que LEVELS tampoco se reusa ahí).
const CLEAR_DEDUPE_CURL =
  "curl -X DELETE 'http://localhost:3001/api/webhooks/dedupe/abc:issues.unlabeled:3872' -H 'x-ia-flow-token: <IA_FLOW_WEBHOOK_SECRET>'"

vi.mock('../api', () => ({
  // Inline literal: `vi.mock` is hoisted above the LEVELS const above.
  fetchServerLogs: vi.fn().mockResolvedValue({
    entries: [
      ...(['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as ServerLogLevel[]).map(
        (level): ServerLogEntry => ({
          level,
          time: '2026-01-01T00:00:00.000Z',
          module: 'test',
          msg: `mensaje ${level}`,
        }),
      ),
      {
        level: 'info',
        time: '2026-01-01T00:00:01.000Z',
        module: 'daemon',
        msg: 'Rules NOT matched',
        extras: {
          clearDedupe:
            "curl -X DELETE 'http://localhost:3001/api/webhooks/dedupe/abc:issues.unlabeled:3872' -H 'x-ia-flow-token: <IA_FLOW_WEBHOOK_SECRET>'",
          // A propósito el mismo nombre que la columna base `module` — el
          // path con prefijo (`extras.module`) es lo que evita que se
          // confunda con `entry.module` ('daemon').
          module: 'extras-module-value',
        },
      } satisfies ServerLogEntry,
    ],
    total: 7,
    levelCounts: { trace: 1, debug: 1, info: 2, warn: 1, error: 1, fatal: 1 },
  }),
  fetchServerLogModules: vi.fn().mockResolvedValue(['test', 'daemon']),
  fetchServerLogSources: vi.fn().mockResolvedValue([]),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
}))

import ServerLogsSection from '../ServerLogsSection.vue'

// Aislamiento entre tests — más de un describe toca `ia-flow:server-logs:columns`.
beforeEach(() => {
  localStorage.clear()
})

// Reads the inline style of every `.log-level` pill, keyed by its level text.
// `level` ya no es columna default (sólo Fecha/Módulo/Mensaje) — se agrega vía
// localStorage antes de montar para poder seguir probando el color del pill
// sin pasar por la UI de "+ columna".
async function mountPills(): Promise<Record<string, CSSStyleDeclaration>> {
  localStorage.setItem(COLUMNS_KEY, JSON.stringify(['time', 'level', 'module', 'msg']))
  const wrapper = mount(ServerLogsSection)
  await flushPromises()
  const pills: Record<string, CSSStyleDeclaration> = {}
  for (const pill of wrapper.findAll('.log-level')) {
    pills[pill.text()] = (pill.element as HTMLElement).style
  }
  return pills
}

describe('ServerLogsSection — colores del pill de nivel', () => {
  it('pinta el pill de debug con foreground oscuro sobre el fondo cyan', async () => {
    const pills = await mountPills()
    expect(pills.debug.background).toBe('var(--info)')
    expect(pills.debug.color).toBe('var(--panel)')
  })

  it('no usa el accent verde como foreground de ningún pill (contraste ilegible)', async () => {
    const pills = await mountPills()
    for (const level of LEVELS) {
      expect(pills[level].color).not.toBe('var(--accent)')
    }
  })

  it('deja el resto de los niveles con su par bg/fg original', async () => {
    const pills = await mountPills()
    const expected: Record<string, { bg: string; fg: string }> = {
      trace: { bg: 'var(--fg-dim)', fg: 'var(--panel)' },
      info: { bg: 'var(--accent)', fg: 'var(--panel)' },
      warn: { bg: 'var(--warn)', fg: 'var(--panel)' },
      error: { bg: 'var(--danger)', fg: 'var(--panel)' },
      fatal: { bg: 'var(--danger)', fg: 'var(--panel)' },
    }
    for (const [level, { bg, fg }] of Object.entries(expected)) {
      expect(pills[level].background).toBe(bg)
      expect(pills[level].color).toBe(fg)
    }
  })
})

describe('ServerLogsSection — botón "Copiar curl (limpiar dedupe)"', () => {
  it('sólo aparece en la fila expandida cuando extras.clearDedupe está presente', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()

    const rows = wrapper.findAll('.log-row')
    // La última fila es la que mockeamos con `extras.clearDedupe`.
    await rows[rows.length - 1]?.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="server-logs-copy-clear-dedupe"]').exists()).toBe(true)

    // Una fila SIN `clearDedupe` (ej. la primera, `trace`) no lo muestra.
    await rows[rows.length - 1]?.trigger('click') // colapsa
    await rows[0]?.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="server-logs-copy-clear-dedupe"]').exists()).toBe(false)
  })

  it('copia el curl exacto de extras.clearDedupe al portapapeles', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    // happy-dom expone `navigator.clipboard` como getter — hay que redefinir
    // la propiedad, `Object.assign` tira (ver ui/test/CopyButton.test.ts).
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    const rows = wrapper.findAll('.log-row')
    await rows[rows.length - 1]?.trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="server-logs-copy-clear-dedupe"]').trigger('click')

    expect(writeText).toHaveBeenCalledWith(CLEAR_DEDUPE_CURL)
  })
})

describe('ServerLogsSection — columnas de extras (estilo Datadog)', () => {
  // La fila con extras (`clearDedupe`) es la última — mismo fixture que el
  // describe de arriba.
  async function expandExtrasRow(wrapper: ReturnType<typeof mount>) {
    const rows = wrapper.findAll('.log-row')
    await rows[rows.length - 1]?.trigger('click')
    await flushPromises()
  }

  function extraColHeader(wrapper: ReturnType<typeof mount>) {
    return wrapper.find('[data-testid="server-logs-col-header-extras.clearDedupe"]')
  }

  it('el "…" de un campo del detalle ofrece "Agregar columna", y agregarla la muestra en el header y en la fila', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await expandExtrasRow(wrapper)

    await wrapper.find('[data-testid="json-tree-field-menu-extras.clearDedupe"]').trigger('click')
    const addBtn = wrapper
      .findAll('.detail-field-menu-item')
      .find((b) => b.text() === 'Agregar columna')
    expect(addBtn).toBeTruthy()
    await addBtn?.trigger('click')
    await flushPromises()

    expect(extraColHeader(wrapper).exists()).toBe(true)
    expect(extraColHeader(wrapper).text()).toContain('clearDedupe')
    // La fila con el campo lo muestra; el resto de las filas (sin
    // clearDedupe) muestran '—'.
    const cells = wrapper.findAll('.log-cell--extra')
    expect(cells.some((c) => c.text().includes('curl'))).toBe(true)
    expect(cells.some((c) => c.text() === '—')).toBe(true)
  })

  it('el "…" alterna a "Quitar columna" una vez agregada, y quitarla la saca del header', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await expandExtrasRow(wrapper)

    await wrapper.find('[data-testid="json-tree-field-menu-extras.clearDedupe"]').trigger('click')
    await wrapper
      .findAll('.detail-field-menu-item')
      .find((b) => b.text() === 'Agregar columna')
      ?.trigger('click')
    await flushPromises()
    expect(extraColHeader(wrapper).exists()).toBe(true)

    await wrapper.find('[data-testid="json-tree-field-menu-extras.clearDedupe"]').trigger('click')
    const removeBtn = wrapper
      .findAll('.detail-field-menu-item')
      .find((b) => b.text() === 'Quitar columna')
    expect(removeBtn).toBeTruthy()
    await removeBtn?.trigger('click')
    await flushPromises()

    expect(extraColHeader(wrapper).exists()).toBe(false)
  })

  it('la "×" del header también quita la columna', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await expandExtrasRow(wrapper)
    await wrapper.find('[data-testid="json-tree-field-menu-extras.clearDedupe"]').trigger('click')
    await wrapper
      .findAll('.detail-field-menu-item')
      .find((b) => b.text() === 'Agregar columna')
      ?.trigger('click')
    await flushPromises()

    await extraColHeader(wrapper).find('.log-col-remove').trigger('click')
    await flushPromises()

    expect(extraColHeader(wrapper).exists()).toBe(false)
  })

  // Sacar una columna base (Módulo) tiene que funcionar igual que una de
  // extras — es justo lo que antes no se podía hacer.
  it('también se puede quitar una columna base (Módulo)', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    expect(wrapper.find('[data-testid="server-logs-col-header-module"]').exists()).toBe(true)

    await wrapper
      .find('[data-testid="server-logs-col-header-module"] .log-col-remove')
      .trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="server-logs-col-header-module"]').exists()).toBe(false)
  })

  // toggleColumn (el "…" del detalle) tiene que respetar el mismo guard que
  // removeColumn — si no, sacar la ÚLTIMA columna desde ahí deja
  // activeColumns en [], desincronizado de lo persistido hasta recargar.
  it('quitar la última columna desde el "…" del detalle no la deja en cero', async () => {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(['extras.clearDedupe']))
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await expandExtrasRow(wrapper)

    await wrapper.find('[data-testid="json-tree-field-menu-extras.clearDedupe"]').trigger('click')
    const removeBtn = wrapper
      .findAll('.detail-field-menu-item')
      .find((b) => b.text() === 'Quitar columna')
    expect(removeBtn).toBeTruthy()
    await removeBtn?.trigger('click')
    await flushPromises()

    expect(extraColHeader(wrapper).exists()).toBe(true)
    expect(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? '[]')).toEqual(['extras.clearDedupe'])
  })

  it('el "+" del header ofrece las columnas base ocultas y las claves de extras descubiertas', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()

    await wrapper.find('[data-testid="server-logs-add-column"]').trigger('click')
    await flushPromises()

    const items = wrapper.findAll('.log-add-column-item').map((i) => i.text())
    expect(items).toContain('clearDedupe')

    await wrapper
      .findAll('.log-add-column-item')
      .find((i) => i.text() === 'clearDedupe')
      ?.trigger('click')
    await flushPromises()

    expect(extraColHeader(wrapper).exists()).toBe(true)
    // Una vez agregada, ya no se vuelve a ofrecer en el picker.
    await wrapper.find('[data-testid="server-logs-add-column"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.log-add-column-item').map((i) => i.text())).not.toContain(
      'clearDedupe',
    )
  })

  it('el input de texto libre agrega una columna anidada (extras.err.message)', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await wrapper.find('[data-testid="server-logs-add-column"]').trigger('click')
    await flushPromises()

    await wrapper
      .find('[data-testid="server-logs-add-column-custom"]')
      .setValue('extras.err.message')
    await wrapper.find('.log-add-column-custom').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[data-testid="server-logs-col-header-extras.err.message"]').exists()).toBe(
      true,
    )
  })

  // getNestedValue usa Object.hasOwn, no `in` — `in` recorre la cadena de
  // prototipos, así que un camino como `__proto__.toString` (posible desde
  // el input de texto libre) no puede devolver una función interna de JS.
  it('un camino que apunta a la cadena de prototipos no filtra nada — se ve como "—"', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await wrapper.find('[data-testid="server-logs-add-column"]').trigger('click')
    await flushPromises()
    await wrapper
      .find('[data-testid="server-logs-add-column-custom"]')
      .setValue('__proto__.toString')
    await wrapper.find('.log-add-column-custom').trigger('submit')
    await flushPromises()

    const cells = wrapper.findAll('.log-cell--extra')
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) expect(cell.text()).toBe('—')
  })

  it('la columna agregada persiste en localStorage (junto a las base) y sobrevive un remount', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await expandExtrasRow(wrapper)
    await wrapper.find('[data-testid="json-tree-field-menu-extras.clearDedupe"]').trigger('click')
    await wrapper
      .findAll('.detail-field-menu-item')
      .find((b) => b.text() === 'Agregar columna')
      ?.trigger('click')
    await flushPromises()
    wrapper.unmount()

    expect(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? '[]')).toEqual([
      'time',
      'module',
      'msg',
      'extras.clearDedupe',
    ])

    const remounted = mount(ServerLogsSection)
    await flushPromises()
    expect(extraColHeader(remounted).exists()).toBe(true)
  })

  it('drag & drop en el header reordena las columnas', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    // Default: time, module, msg — arrastramos "module" sobre "time".
    const before = wrapper.findAll('.log-col-header').map((h) => h.attributes('data-testid'))
    expect(before).toEqual([
      'server-logs-col-header-time',
      'server-logs-col-header-module',
      'server-logs-col-header-msg',
    ])

    await wrapper.find('[data-testid="server-logs-col-header-module"]').trigger('dragstart')
    await wrapper.find('[data-testid="server-logs-col-header-time"]').trigger('dragover')
    await wrapper.find('[data-testid="server-logs-col-header-time"]').trigger('drop')
    await flushPromises()

    const after = wrapper.findAll('.log-col-header').map((h) => h.attributes('data-testid'))
    expect(after).toEqual([
      'server-logs-col-header-module',
      'server-logs-col-header-time',
      'server-logs-col-header-msg',
    ])
    expect(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? '[]')).toEqual(['module', 'time', 'msg'])
  })

  // Sin esto, arrastrar una columna no daba ninguna pista de dónde iba a
  // quedar hasta soltar — el pedido concreto que motivó el fix.
  it('mientras se arrastra, el origen se atenúa y el destino se resalta', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    const moduleHeader = wrapper.find('[data-testid="server-logs-col-header-module"]')
    const timeHeader = wrapper.find('[data-testid="server-logs-col-header-time"]')

    await moduleHeader.trigger('dragstart')
    expect(moduleHeader.classes()).toContain('log-col-header--dragging')

    await timeHeader.trigger('dragover')
    expect(timeHeader.classes()).toContain('log-col-header--drag-over')
    // El origen nunca se marca como "destino" de sí mismo.
    expect(moduleHeader.classes()).not.toContain('log-col-header--drag-over')
    // Sólo el header se resalta — ya no toda la columna fila por fila (era
    // demasiado ruido visual sobre datos reales).
    expect(wrapper.findAll('.log-cell--drag-over')).toHaveLength(0)

    await timeHeader.trigger('dragleave')
    expect(timeHeader.classes()).not.toContain('log-col-header--drag-over')

    // dragend (soltar afuera, Esc, etc.) apaga el estado "atenuado" del
    // origen aunque nunca haya habido un drop.
    await moduleHeader.trigger('dragend')
    expect(moduleHeader.classes()).not.toContain('log-col-header--dragging')
  })

  it('el buscador del picker filtra por nombre, en base y en extras', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await wrapper.find('[data-testid="server-logs-add-column"]').trigger('click')
    await flushPromises()

    // Sin filtro: level (base, oculta) y clearDedupe (extras) están las dos.
    expect(wrapper.findAll('.log-add-column-item').map((i) => i.text())).toEqual(
      expect.arrayContaining(['Nivel', 'clearDedupe']),
    )

    await wrapper.find('[data-testid="server-logs-add-column-search"]').setValue('clear')
    await flushPromises()

    const items = wrapper.findAll('.log-add-column-item').map((i) => i.text())
    expect(items).toEqual(['clearDedupe'])
  })

  // Antes un `extras.module` no se podía agregar como columna (se confundía
  // con la base `module`). Con el path con prefijo (`extras.module`) las dos
  // columnas conviven y cada una muestra su propio valor.
  it('una clave de extras que colisiona de nombre con una columna base tiene su propio path y valor', async () => {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(['time', 'module', 'msg', 'extras.module']))
    const wrapper = mount(ServerLogsSection)
    await flushPromises()

    expect(wrapper.find('[data-testid="server-logs-col-header-module"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="server-logs-col-header-extras.module"]').exists()).toBe(true)

    const cells = wrapper.findAll('.log-cell--module').map((c) => c.text())
    expect(cells).toContain('daemon')
    const extraCells = wrapper.findAll('.log-cell--extra').map((c) => c.text())
    expect(extraCells).toContain('extras-module-value')
  })
})

describe('ServerLogsSection — resize de columnas', () => {
  afterEach(() => {
    // `startColumnResize` engancha mousemove/mouseup en `document` — un
    // resize que un test deja a medias (assert que tira antes del mouseup)
    // dejaría esos listeners vivos para el próximo test.
    document.dispatchEvent(new MouseEvent('mouseup'))
  })

  it('arrastrar el handle cambia el ancho de la columna y lo persiste', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    const handle = wrapper.find('[data-testid="server-logs-col-resize-time"]')

    await handle.trigger('mousedown', { clientX: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 280 }))
    await flushPromises()
    document.dispatchEvent(new MouseEvent('mouseup'))
    await flushPromises()

    const stored = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) ?? '{}')
    expect(stored.time).toBeGreaterThan(0)
    expect(wrapper.find('.log-list-header').attributes('style')).toContain(`${stored.time}px`)
  })

  it('el ancho resizeado sobrevive un remount (localStorage)', async () => {
    localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify({ time: 300 }))
    const wrapper = mount(ServerLogsSection)
    await flushPromises()

    expect(wrapper.find('.log-list-header').attributes('style')).toContain('300px')
  })

  it('no deja resizear por debajo del piso mínimo', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    const handle = wrapper.find('[data-testid="server-logs-col-resize-time"]')

    await handle.trigger('mousedown', { clientX: 100 })
    // Un delta muy negativo intentaría un ancho negativo — se clampea al piso.
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: -500 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await flushPromises()

    const stored = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) ?? '{}')
    expect(stored.time).toBe(60)
  })

  // El handle vive DENTRO de un header con `draggable="true"` (reordenar) —
  // sin el preventDefault del mousedown, arrastrar el handle dispararía
  // también el drag nativo de reordenamiento.
  it('el mousedown del handle no dispara el drag de reordenar columnas', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    const handle = wrapper.find('[data-testid="server-logs-col-resize-time"]')
    const timeHeader = wrapper.find('[data-testid="server-logs-col-header-time"]')

    await handle.trigger('mousedown', { clientX: 100 })
    expect(timeHeader.classes()).not.toContain('log-col-header--dragging')
    document.dispatchEvent(new MouseEvent('mouseup'))
  })
})
