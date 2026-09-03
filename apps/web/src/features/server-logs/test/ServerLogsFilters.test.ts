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
  fetchServerLogs: vi.fn(),
  fetchServerLogModules: vi.fn(),
  fetchServerLogSources: vi.fn().mockResolvedValue([]),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
}))
// Skip the WS lifecycle entirely — happy-dom doesn't ship a functional
// WebSocket, y live mode de este panel no está bajo test acá (mismo patrón
// que ExecutionsSection.test.ts).
vi.mock('@/composables/useServerEvents', () => ({
  useServerEvents: () => ({ connected: { value: false } }),
}))

import ServerLogsSection from '../ServerLogsSection.vue'
import { fetchServerLogModules, fetchServerLogs } from '../api'

const EMPTY_PAGE = {
  entries: [] as ServerLogEntry[],
  total: 0,
  levelCounts: { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 3 },
}

beforeEach(() => {
  vi.mocked(fetchServerLogModules).mockResolvedValue([...MANY_MODULES])
  vi.mocked(fetchServerLogs).mockReset()
  vi.mocked(fetchServerLogs).mockResolvedValue(EMPTY_PAGE)
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

// Todo lo que una línea dice de sí misma es filtrable, no sólo su nivel y su
// módulo: de quién es (agente), sobre qué (tarea, proyecto) y de qué corrida.
describe('ServerLogsSection — los campos de `extras`', () => {
  const withExtras = (extras: Record<string, string>): ServerLogEntry => ({
    level: 'info',
    time: '2026-01-01T00:00:00.000Z',
    module: 'engine',
    msg: 'trabajando',
    extras,
  })

  it('sugiere agentes, tareas y proyectos vistos en las líneas cargadas', async () => {
    vi.mocked(fetchServerLogs).mockResolvedValue({
      ...EMPTY_PAGE,
      entries: [
        withExtras({ agentId: 'refiner', taskId: 't-12', projectId: 'ia-flow' }),
        withExtras({ agentId: 'builder', taskId: 't-12', projectId: 'ia-flow' }),
      ],
    })
    const wrapper = await mountSection()

    await typeFilter(wrapper, 'agente:')
    expect(options(wrapper)).toEqual(['builder', 'refiner'])
    // La tarea repetida en dos líneas se sugiere una vez.
    await typeFilter(wrapper, 'tarea:')
    expect(options(wrapper)).toEqual(['t-12'])
  })

  it('filtra por agente y por tarea con el payload del server', async () => {
    const wrapper = await mountSection()
    const input = wrapper.get(INPUT)
    await input.setValue('agente:refiner')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await input.setValue('tarea:t-12')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(vi.mocked(fetchServerLogs).mock.calls.at(-1)?.[0]).toMatchObject({
      agentId: ['refiner'],
      taskId: ['t-12'],
    })
  })

  // `extras.task` es el título — sólo lo estampa el camino sync, al lado del
  // `taskId` opaco. Mismo campo libre que `tarea`, con su propia key.
  it('sugiere y filtra por título de tarea (`titulo`)', async () => {
    vi.mocked(fetchServerLogs).mockResolvedValue({
      ...EMPTY_PAGE,
      entries: [withExtras({ taskId: 't-12', task: 'Arreglar el bug de dedupe' })],
    })
    const wrapper = await mountSection()

    await typeFilter(wrapper, 'titulo:')
    expect(options(wrapper)).toEqual(['Arreglar el bug de dedupe'])

    const input = wrapper.get(INPUT)
    await input.setValue('titulo:Arreglar el bug de dedupe')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(vi.mocked(fetchServerLogs).mock.calls.at(-1)?.[0]).toMatchObject({
      task: ['Arreglar el bug de dedupe'],
    })
  })

  // No hay endpoint que liste el universo de tareas: pegar un id de otra
  // pantalla tiene que funcionar aunque no esté en la página.
  it('acepta un valor que no está en las líneas cargadas', async () => {
    const wrapper = await mountSection()
    const input = await typeFilter(wrapper, 'tarea:t-de-otra-pantalla')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(vi.mocked(fetchServerLogs).mock.calls.at(-1)?.[0]).toMatchObject({
      taskId: ['t-de-otra-pantalla'],
    })
  })

  it('dos corridas se pueden mirar juntas', async () => {
    const wrapper = await mountSection()
    const input = wrapper.get(INPUT)
    for (const run of ['run-a', 'run-b']) {
      await input.setValue(`run:${run}`)
      await input.trigger('keydown', { key: 'Enter' })
      await flushPromises()
    }

    expect(vi.mocked(fetchServerLogs).mock.calls.at(-1)?.[0]).toMatchObject({
      runId: ['run-a', 'run-b'],
    })
  })

  it('clickear un conteo de nivel prende y apaga su token', async () => {
    const wrapper = await mountSection()
    const chip = wrapper.get('[data-testid="server-logs-summary-fatal"]')
    expect(chip.attributes('aria-pressed')).toBe('false')

    await chip.trigger('click')
    await flushPromises()
    expect(chip.attributes('aria-pressed')).toBe('true')
    expect(vi.mocked(fetchServerLogs).mock.calls.at(-1)?.[0]).toMatchObject({ level: 'fatal' })

    await chip.trigger('click')
    await flushPromises()
    expect(vi.mocked(fetchServerLogs).mock.calls.at(-1)?.[0]).not.toHaveProperty('level')
  })
})
