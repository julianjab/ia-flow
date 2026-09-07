import NextUpSection from '@/features/tasks/NextUpSection.vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const items: Array<Record<string, unknown>> = []
const runSummaries: Array<Record<string, unknown>> = []
const blockersBatch: Record<string, unknown[]> = {}

vi.mock('@/features/projects/store', () => ({
  useProjectsStore: () => ({ activeProjectId: 'p1' }),
}))
vi.mock('@/features/projects/sourceApi', () => ({
  fetchProjectItems: vi.fn(async () => ({ kind: 'github-issues', items })),
}))
const fetchTaskRunSummaries = vi.fn(async () => runSummaries)
const fetchBlockersBatch = vi.fn(async () => blockersBatch)
vi.mock('@/features/tasks/api', () => ({
  fetchTaskRunSummaries: (...a: unknown[]) => fetchTaskRunSummaries(...(a as [])),
  fetchBlockersBatch: (...a: unknown[]) => fetchBlockersBatch(...(a as [])),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

function task(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: `Tarea ${id}`,
    status: 'build',
    repos: 'ia-flow',
    meta: { issueNumber: Number(id.slice(1)), issueUrl: `https://gh/${id}`, ...over },
  }
}

function run(taskId: string, over: Record<string, unknown> = {}) {
  return {
    taskId,
    attempts: 1,
    last: {
      id: `run-${taskId}`,
      projectId: 'p1',
      taskId,
      taskTitle: 'x',
      agentId: 'implementer',
      providerId: 'anthropic-api',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outcome: 'success',
      errorMsg: null,
      stopReason: null,
      ...over,
    },
  }
}

beforeEach(() => {
  items.splice(0, items.length)
  runSummaries.splice(0, runSummaries.length)
  for (const k of Object.keys(blockersBatch)) delete blockersBatch[k]
})

async function mountWith() {
  const wrapper = mount(NextUpSection)
  await flushPromises()
  await flushPromises()
  return wrapper
}

describe('NextUpSection', () => {
  // El orden es la pantalla: primero lo que NO avanza solo.
  it('ordena por severidad: falló → bloqueada → corriendo → sin ejecutar', async () => {
    items.push(task('i1'), task('i2'), task('i3'), task('i4'))
    runSummaries.push(
      run('i1', { outcome: 'error', failureClass: 'tests' }),
      run('i3', { finishedAt: null, outcome: null }),
    )
    blockersBatch.i2 = [{ id: 'b', ref: '#1236' }]
    const wrapper = await mountWith()
    const reasons = wrapper.findAll('.nu-reason').map((r) => r.text())
    expect(reasons[0]).toContain('falló')
    expect(reasons[1]).toContain('bloqueada por #1236')
    expect(reasons[2]).toContain('corriendo')
    expect(reasons[3]).toContain('sin ejecutar')
  })

  // La razón es lo que distingue esta pantalla de un listado por fecha.
  it('cada fila dice por qué está ahí, con el conteo de intentos', async () => {
    items.push(task('i1'))
    runSummaries.push({ ...run('i1', { outcome: 'error', failureClass: 'tests' }), attempts: 2 })
    const wrapper = await mountWith()
    const reason = wrapper.get('.nu-reason')
    expect(reason.text()).toContain('2 intentos')
    expect(reason.text()).toContain('no reintenta solo')
  })

  // Aprobar/mergear desde la app no existe: la acción abre el PR en GitHub.
  it('la acción sugerida abre el PR, no promete un botón', async () => {
    items.push(
      task('i1', {
        pullRequests: [
          { number: 7, url: 'https://gh/pr/7', state: 'open', isDraft: false, ci: 'success' },
        ],
      }),
    )
    runSummaries.push(run('i1'))
    const wrapper = await mountWith()
    const action = wrapper.get('.nu-action')
    expect(action.attributes('href')).toBe('https://gh/pr/7')
    expect(action.attributes('target')).toBe('_blank')
  })

  // "No sé" no se dibuja como "no hay": sin el agregado, una tarea sin runs no
  // entra a la cola como "sin ejecutar"…
  it('si el agregado de runs falla, no afirma que nada corrió', async () => {
    items.push(task('i1'))
    fetchTaskRunSummaries.mockRejectedValueOnce(new Error('502'))
    const wrapper = await mountWith()
    expect(wrapper.text()).not.toContain('sin ejecutar')
  })

  // …y el vacío que eso produce NO se puede leer como "no hay nada esperando":
  // sería la afirmación falsa más cara de la pantalla.
  it('sin el agregado, dice que la cola está incompleta en vez de "no hay nada"', async () => {
    items.push(task('i1'))
    fetchTaskRunSummaries.mockRejectedValueOnce(new Error('502'))
    const wrapper = await mountWith()
    expect(wrapper.get('.nu-degraded').text()).toContain('incompleta')
    expect(wrapper.text()).not.toContain('No hay nada esperando')
  })

  // El resumen del proyecto lo tiene que escribir un modelo y ese endpoint no
  // existe: mejor no dibujar la card que inventarle un texto.
  it('no muestra card de resumen mientras el endpoint no exista', async () => {
    items.push(task('i1'))
    runSummaries.push(run('i1', { outcome: 'error' }))
    const wrapper = await mountWith()
    expect(wrapper.find('.nu-summary').exists()).toBe(false)
  })

  it('los primeros tres puestos se marcan como accionables ahora', async () => {
    for (const id of ['i1', 'i2', 'i3', 'i4']) items.push(task(id))
    runSummaries.push(
      run('i1', { outcome: 'error' }),
      run('i2', { outcome: 'error' }),
      run('i3', { outcome: 'error' }),
      run('i4', { outcome: 'error' }),
    )
    const wrapper = await mountWith()
    const ranks = wrapper.findAll('.nu-rank')
    expect(ranks.filter((r) => r.classes().includes('is-now'))).toHaveLength(3)
  })

  // Un id ausente del mapa de blockers es "no se pudo saber": tratarlo como
  // "no está bloqueada" es afirmar justo lo que esta pantalla existe para
  // decir, y sin haberlo consultado.
  it('no afirma que una tarea está libre si no se pudieron consultar sus bloqueos', async () => {
    items.push(task('i1'))
    fetchBlockersBatch.mockResolvedValueOnce({})
    const wrapper = await mountWith()
    expect(wrapper.get('.nu-reason').text()).toContain('bloqueos sin consultar')
  })

  it('una recarga que falla no clasifica con los datos de la corrida anterior', async () => {
    items.push(task('i1'))
    runSummaries.push(run('i1', { outcome: 'error' }))
    const wrapper = await mountWith()
    expect(wrapper.get('.nu-reason').text()).toContain('falló')

    fetchTaskRunSummaries.mockRejectedValueOnce(new Error('502'))
    await wrapper.get('.section-head-actions .btn').trigger('click')
    await flushPromises()
    await flushPromises()
    expect(wrapper.findAll('.nu-reason').map((r) => r.text())).not.toContain(
      expect.stringContaining('falló'),
    )
  })

  it('un proyecto sin nada esperando lo dice', async () => {
    items.push(task('i1'))
    runSummaries.push(run('i1'))
    const wrapper = await mountWith()
    // Terminada y sin PR abierto: no hay nada que decidir sobre ella.
    expect(wrapper.get('.nu-empty').text()).toContain('No hay nada esperando')
  })
})
