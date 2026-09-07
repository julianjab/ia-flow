import StatusesSection from '@/features/statuses/StatusesSection.vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const items: Array<Record<string, unknown>> = []
const statuses: Array<{ name: string }> = [{ name: 'build' }, { name: 'review' }, { name: 'done' }]
const runSummaries: Array<Record<string, unknown>> = []
const blockersBatch: Record<string, unknown[]> = {}

vi.mock('@/features/projects/store', () => ({
  useProjectsStore: () => ({ activeProjectId: 'p1' }),
}))
vi.mock('@/features/project-config/store', () => ({
  useProjectConfigStore: () => ({ config: { statuses: [] } }),
}))
vi.mock('@/stores/toast', () => ({ useToastStore: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/features/projects/sourceApi', () => ({
  fetchProjectItems: vi.fn(async () => ({ kind: 'github-issues', items })),
  fetchProjectStatuses: vi.fn(async () => ({ kind: 'github-issues', statuses })),
}))
const fetchTaskRunSummaries = vi.fn(async () => runSummaries)
const fetchBlockersBatch = vi.fn(async () => blockersBatch)
vi.mock('@/features/tasks/api', () => ({
  fetchTaskRunSummaries: (...a: unknown[]) => fetchTaskRunSummaries(...(a as [])),
  fetchBlockersBatch: (...a: unknown[]) => fetchBlockersBatch(...(a as [])),
}))
vi.mock('@/features/statuses/statusesApi', () => ({
  createStatus: vi.fn(),
  deleteStatus: vi.fn(),
  updateStatus: vi.fn(),
}))

function task(id: string, status: string) {
  return { id, title: `Tarea ${id}`, status, repos: '', meta: { issueNumber: 1 } }
}

beforeEach(() => {
  items.splice(0, items.length)
  runSummaries.splice(0, runSummaries.length)
  for (const k of Object.keys(blockersBatch)) delete blockersBatch[k]
})

async function mountWith() {
  const wrapper = mount(StatusesSection, {
    global: { stubs: { RouterLink: true, StatusConfigModal: true, ConfirmDialog: true } },
  })
  await flushPromises()
  await flushPromises()
  return wrapper
}

describe('StatusesSection — board', () => {
  it('un chip por status, con su contador', async () => {
    items.push(task('a', 'build'), task('b', 'build'), task('c', 'review'))
    const wrapper = await mountWith()
    const chips = wrapper.findAll('.bd-chip')
    expect(chips.map((c) => c.text())).toEqual(['build 2', 'review 1', 'done 0'])
  })

  // Una columna por vez: en un teléfono un board de 5 columnas se lee
  // scrolleando de lado y perdiendo el hilo.
  it('muestra una sola columna y la cambia al tocar un chip', async () => {
    items.push(task('a', 'build'), task('c', 'review'))
    const wrapper = await mountWith()
    expect(wrapper.findAll('.tr')).toHaveLength(1)
    expect(wrapper.get('.tr__title').text()).toContain('Tarea a')

    await wrapper.findAll('.bd-chip')[1].trigger('click')
    expect(wrapper.get('.tr__title').text()).toContain('Tarea c')
  })

  it('el chip activo va en video inverso', async () => {
    items.push(task('a', 'build'))
    const wrapper = await mountWith()
    expect(wrapper.findAll('.bd-chip')[0].classes()).toContain('is-active')
  })

  // El número de atención de la etapa: cuántas no tiene quién las mueva.
  it('cuenta las que nunca corrieron y no están bloqueadas', async () => {
    items.push(task('a', 'build'), task('b', 'build'))
    blockersBatch.b = [{ id: 'x' }]
    const wrapper = await mountWith()
    expect(wrapper.get('.bd-col-stalled').text()).toContain('1 sin correr')
  })

  // Sin el agregado no se sabe cuáles corrieron: decir "2 sin correr" sería
  // contar las que sí corrieron.
  it('sin el agregado de runs no muestra el contador de atención', async () => {
    items.push(task('a', 'build'))
    fetchTaskRunSummaries.mockRejectedValueOnce(new Error('502'))
    const wrapper = await mountWith()
    expect(wrapper.find('.bd-col-stalled').exists()).toBe(false)
  })

  it('cada fila lleva la misma línea de estado que el listado', async () => {
    items.push(task('a', 'build'))
    const wrapper = await mountWith()
    // Dos: el glifo de la columna 1 y la línea completa debajo del título.
    expect(wrapper.findAll('.tr .esl').length).toBeGreaterThanOrEqual(1)
  })

  it('una columna vacía lo dice', async () => {
    items.push(task('c', 'review'))
    const wrapper = await mountWith()
    await wrapper.findAll('.bd-chip')[2].trigger('click')
    expect(wrapper.text()).toContain('Ninguna tarea en done')
  })
})
