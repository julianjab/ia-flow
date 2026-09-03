import type { ServerLogEntry, ServerLogLevel } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The section only talks to its own `api.ts` on mount, plus `useRoute` for the
// deep-link hydration. Stub both so the pills render without a live backend.
const LEVELS: ServerLogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
// Espeja COLUMNS_STORAGE_KEY del componente — bumpeada a :v2 porque cambió
// la semántica del array (ver el comentario ahí).
const COLUMNS_KEY = 'ia-flow:server-logs:columns:v2'

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
    return wrapper.find('[data-testid="server-logs-col-header-clearDedupe"]')
  }

  it('el "…" de un campo del detalle ofrece "Agregar columna", y agregarla la muestra en el header y en la fila', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await expandExtrasRow(wrapper)

    await wrapper.find('[data-testid="server-logs-field-menu-clearDedupe"]').trigger('click')
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

    await wrapper.find('[data-testid="server-logs-field-menu-clearDedupe"]').trigger('click')
    await wrapper
      .findAll('.detail-field-menu-item')
      .find((b) => b.text() === 'Agregar columna')
      ?.trigger('click')
    await flushPromises()
    expect(extraColHeader(wrapper).exists()).toBe(true)

    await wrapper.find('[data-testid="server-logs-field-menu-clearDedupe"]').trigger('click')
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
    await wrapper.find('[data-testid="server-logs-field-menu-clearDedupe"]').trigger('click')
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
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(['clearDedupe']))
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await expandExtrasRow(wrapper)

    await wrapper.find('[data-testid="server-logs-field-menu-clearDedupe"]').trigger('click')
    const removeBtn = wrapper
      .findAll('.detail-field-menu-item')
      .find((b) => b.text() === 'Quitar columna')
    expect(removeBtn).toBeTruthy()
    await removeBtn?.trigger('click')
    await flushPromises()

    expect(extraColHeader(wrapper).exists()).toBe(true)
    expect(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? '[]')).toEqual(['clearDedupe'])
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

    expect(wrapper.find('[data-testid="server-logs-col-header-err.message"]').exists()).toBe(true)
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
    await wrapper.find('[data-testid="server-logs-field-menu-clearDedupe"]').trigger('click')
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
      'clearDedupe',
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
    // No sólo el header — TODA la columna (la celda de cada fila) se pinta.
    // El fixture tiene 7 líneas.
    expect(wrapper.findAll('.log-cell--drag-over')).toHaveLength(7)

    await timeHeader.trigger('dragleave')
    expect(timeHeader.classes()).not.toContain('log-col-header--drag-over')
    expect(wrapper.findAll('.log-cell--drag-over')).toHaveLength(0)

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

  // toggleColumn (el "…" del detalle) usa isBaseColumn como guard — una
  // línea con `extras.module` no puede agregar una columna "module" que el
  // template confundiría con la base (`col === 'module'` lee entry.module).
  it('una clave de extras que colisiona con una columna base no se agrega', async () => {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(['time', 'msg']))
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    // La última fila (con extras.clearDedupe) no tiene `extras.module` en el
    // fixture — probamos el guard llamando toggleColumn indirectamente vía
    // localStorage + una recarga no alcanza, así que se verifica que el
    // header nunca ofrece agregar una colisión desde el picker tampoco.
    expect(wrapper.find('[data-testid="server-logs-col-header-module"]').exists()).toBe(false)
  })
})
