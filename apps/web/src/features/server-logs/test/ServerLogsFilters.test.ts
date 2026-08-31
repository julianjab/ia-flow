import type { ServerLogEntry } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 40 módulos: la forma que produjo el "+19 más…" que el operador reportó, y la
// razón por la que la fila de chips tenía cap, buscador propio y botón de
// expandir. Con el input de `campo:valor` no hay corte que esconda nada — la
// lista vive en el menú y se filtra escribiendo.
const MANY_MODULES = Array.from({ length: 40 }, (_, i) => `mod-${String(i).padStart(2, '0')}`)
// Alfabéticamente último: antes sólo se alcanzaba pasando el corte.
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

type Wrapper = Awaited<ReturnType<typeof mountSection>>

const INPUT = '[data-testid="server-logs-filter-input"]'

function options(wrapper: Wrapper): string[] {
  return wrapper.findAll('.fq-option__value').map((o) => o.text())
}

async function typeFilter(wrapper: Wrapper, raw: string) {
  const input = wrapper.get(INPUT)
  await input.setValue(raw)
  return input
}

describe('ServerLogsSection — el input de filtros', () => {
  it('ofrece los campos filtrables antes de escribir un valor', async () => {
    const wrapper = await mountSection()
    await typeFilter(wrapper, 'm')

    // `modulo` y `msg` — los dos campos que contienen "m".
    expect(options(wrapper)).toEqual(['modulo:', 'msg:'])
  })

  it('ofrece TODOS los módulos, sin corte ni botón de expandir', async () => {
    const wrapper = await mountSection()
    await typeFilter(wrapper, 'modulo:')

    expect(options(wrapper)).toHaveLength(MANY_MODULES.length)
    expect(options(wrapper)).toContain(HIDDEN_MODULE)
  })

  it('escribir filtra las opciones sin refetchear', async () => {
    const wrapper = await mountSection()
    const callsBefore = vi.mocked(fetchServerLogs).mock.calls.length

    await typeFilter(wrapper, 'modulo:MOD-3')

    expect(options(wrapper)).toEqual([
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
    // Escribir es navegar el menú: la consulta sale recién con el token.
    expect(vi.mocked(fetchServerLogs).mock.calls).toHaveLength(callsBefore)
  })

  it('elegir un módulo refetchea con el filtro en el payload', async () => {
    const wrapper = await mountSection()
    const input = await typeFilter(wrapper, `modulo:${HIDDEN_MODULE}`)
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(vi.mocked(fetchServerLogs)).toHaveBeenCalledWith(
      expect.objectContaining({ module: [HIDDEN_MODULE] }),
    )
  })

  // Un filtro activo que no se ve es un filtro que no se puede apagar: era el
  // bug que la fila colapsada tenía y que el token resuelve por construcción.
  it('el filtro activo queda a la vista como token y se apaga clickeándolo', async () => {
    const wrapper = await mountSection()
    const input = await typeFilter(wrapper, `modulo:${HIDDEN_MODULE}`)
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    const token = wrapper.get(`[data-testid="server-logs-filter-token-modulo-${HIDDEN_MODULE}"]`)
    expect(token.text()).toContain(HIDDEN_MODULE)

    await token.trigger('click')
    await flushPromises()
    expect(vi.mocked(fetchServerLogs).mock.calls.at(-1)?.[0]).not.toHaveProperty('module')
  })

  it('un módulo ya elegido no se vuelve a ofrecer', async () => {
    const wrapper = await mountSection()
    const input = await typeFilter(wrapper, 'modulo:mod-00')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    await typeFilter(wrapper, 'modulo:mod-0')
    expect(options(wrapper)).not.toContain('mod-00')
    expect(options(wrapper)).toContain('mod-01')
  })

  it('el nivel es uno solo: el segundo token reemplaza al primero', async () => {
    const wrapper = await mountSection()
    const input = wrapper.get(INPUT)
    await input.setValue('nivel:warn')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await input.setValue('nivel:error')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(vi.mocked(fetchServerLogs).mock.calls.at(-1)?.[0]).toMatchObject({ level: 'error' })
    expect(wrapper.find('[data-testid="server-logs-filter-token-nivel-warn"]').exists()).toBe(false)
  })

  it('`msg` es texto libre: no ofrece menú y se aplica al confirmar', async () => {
    const wrapper = await mountSection()
    const input = await typeFilter(wrapper, 'msg:timeout')
    expect(options(wrapper)).toHaveLength(0)

    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(vi.mocked(fetchServerLogs).mock.calls.at(-1)?.[0]).toMatchObject({ search: 'timeout' })
  })
})
