import type { ServerLogEntry } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 40 modules — the shape that produced the "+19 más…" the operator reported:
// more than MODULE_CHIP_LIMIT (24), so the collapsed row necessarily cuts.
const MANY_MODULES = Array.from({ length: 40 }, (_, i) => `mod-${String(i).padStart(2, '0')}`)
// Alphabetically last, so it can only be reached past the cut.
const HIDDEN_MODULE = 'mod-39'

vi.mock('../api', () => ({
  fetchServerLogs: vi.fn().mockResolvedValue({
    entries: [] as ServerLogEntry[],
    total: 0,
    levelCounts: { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 },
  }),
  fetchServerLogModules: vi.fn(),
  fetchServerLogSources: vi.fn().mockResolvedValue([]),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
}))

import ServerLogsSection from '../ServerLogsSection.vue'
import { fetchServerLogModules, fetchServerLogs } from '../api'

beforeEach(() => {
  vi.mocked(fetchServerLogModules).mockResolvedValue([...MANY_MODULES])
  vi.mocked(fetchServerLogs).mockClear()
})

async function mountSection() {
  const wrapper = mount(ServerLogsSection)
  await flushPromises()
  return wrapper
}

function chipNames(wrapper: Awaited<ReturnType<typeof mountSection>>): string[] {
  return wrapper.findAll('.chip--module').map((c) => c.text())
}

const toggle = '[data-testid="server-logs-modules-toggle"]'
const search = '[data-testid="server-logs-modules-search"]'

describe('ServerLogsSection — fila de chips de Módulos', () => {
  it('colapsada, corta en 24 y ofrece el resto detrás de un botón', async () => {
    const wrapper = await mountSection()
    expect(chipNames(wrapper)).toHaveLength(24)
    const more = wrapper.find(toggle)
    expect(more.exists()).toBe(true)
    // Un <button>, no el <span> pasivo de antes.
    expect(more.element.tagName).toBe('BUTTON')
    expect(more.text()).toContain('+16')
  })

  it('el botón expande la lista completa y vuelve a colapsar (toggle)', async () => {
    const wrapper = await mountSection()
    await wrapper.find(toggle).trigger('click')
    expect(chipNames(wrapper)).toHaveLength(MANY_MODULES.length)
    expect(wrapper.find(toggle).text()).toContain('Ver menos')

    await wrapper.find(toggle).trigger('click')
    expect(chipNames(wrapper)).toHaveLength(24)
    expect(wrapper.find(toggle).text()).toContain('+16')
  })

  it('un módulo más allá de los primeros 24 se puede activar como filtro', async () => {
    const wrapper = await mountSection()
    expect(chipNames(wrapper)).not.toContain(HIDDEN_MODULE)

    await wrapper.find(toggle).trigger('click')
    await wrapper
      .find(`[data-testid="server-logs-filter-module-chip-${HIDDEN_MODULE}"]`)
      .trigger('click')
    await flushPromises()

    expect(vi.mocked(fetchServerLogs)).toHaveBeenCalledWith(
      expect.objectContaining({ module: [HIDDEN_MODULE] }),
    )
  })

  it('un chip activo queda visible aunque esté fuera de los primeros 24', async () => {
    const wrapper = await mountSection()
    await wrapper.find(toggle).trigger('click')
    await wrapper
      .find(`[data-testid="server-logs-filter-module-chip-${HIDDEN_MODULE}"]`)
      .trigger('click')
    await flushPromises()

    // Volver a colapsar no puede esconder un filtro activo: si no se ve,
    // el operador no puede apagarlo.
    await wrapper.find(toggle).trigger('click')
    expect(chipNames(wrapper)).toContain(HIDDEN_MODULE)
    const chip = wrapper.find(`[data-testid="server-logs-filter-module-chip-${HIDDEN_MODULE}"]`)
    expect(chip.attributes('aria-pressed')).toBe('true')
  })

  it('la búsqueda filtra por substring case-insensitive sin refetchear', async () => {
    const wrapper = await mountSection()
    const callsBefore = vi.mocked(fetchServerLogs).mock.calls.length

    await wrapper.find(search).setValue('MOD-3')
    const names = chipNames(wrapper)
    expect(names).toEqual([
      'mod-30',
      'mod-31',
      'mod-32',
      'mod-33',
      'mod-34',
      'mod-35',
      'mod-36',
      'mod-37',
      'mod-38',
      'mod-39',
    ])
    expect(vi.mocked(fetchServerLogs).mock.calls).toHaveLength(callsBefore)
  })

  it('la búsqueda nunca esconde un chip activo', async () => {
    const wrapper = await mountSection()
    await wrapper.find(toggle).trigger('click')
    await wrapper
      .find(`[data-testid="server-logs-filter-module-chip-${HIDDEN_MODULE}"]`)
      .trigger('click')
    await flushPromises()

    await wrapper.find(search).setValue('mod-01')
    expect(chipNames(wrapper)).toEqual(['mod-01', HIDDEN_MODULE])
  })

  it('no muestra el buscador cuando la lista es corta', async () => {
    vi.mocked(fetchServerLogModules).mockResolvedValue(['engine', 'http'])
    const wrapper = await mountSection()
    expect(wrapper.find(search).exists()).toBe(false)
    expect(wrapper.find(toggle).exists()).toBe(false)
    expect(chipNames(wrapper)).toEqual(['engine', 'http'])
  })

  it('deja la fila de Container sin corte ni buscador', async () => {
    const wrapper = await mountSection()
    // Un solo buscador y un solo toggle en toda la sección: son de Módulos.
    expect(wrapper.findAll(search)).toHaveLength(1)
    expect(wrapper.findAll(toggle)).toHaveLength(1)
  })
})
