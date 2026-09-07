import DashboardView from '@/views/DashboardView.vue'
import type { ExecutionLog } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const recent: ExecutionLog[] = []

vi.mock('@/features/executions/api', () => ({
  fetchExecutions: vi.fn(async () => recent),
  fetchActiveExecutions: vi.fn(async () => []),
}))
vi.mock('@/features/projects/store', () => ({
  useProjectsStore: () => ({ projects: [], fetch: vi.fn() }),
}))

function fail(over: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: `r${Math.random()}`,
    projectId: 'p1',
    taskId: `t${Math.random()}`,
    taskTitle: 'Agregar SID al envío de SMS',
    agentId: 'implementer',
    providerId: 'anthropic-api',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    outcome: 'error',
    errorMsg: null,
    stopReason: null,
    failureClass: 'tests',
    ...over,
  } as ExecutionLog
}

beforeEach(() => {
  setActivePinia(createPinia())
  recent.splice(0, recent.length)
})

async function mountDash() {
  const wrapper = mount(DashboardView, {
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  })
  await flushPromises()
  return wrapper
}

describe('DashboardView — patrón de fallo del día', () => {
  // Un contador dice CUÁNTOS fallaron; el patrón dice si son el MISMO
  // problema, que es lo que decide si hay que arreglar una cosa o seis.
  it('agrupa los fallos del día por su clase', async () => {
    recent.push(fail(), fail(), fail({ failureClass: 'budget_exhausted' }))
    const wrapper = await mountDash()
    const line = wrapper.get('.pattern__line')
    expect(line.text()).toContain('2 de los 3 fallos')
    expect(line.text()).toContain('tests')
  })

  // Con un solo fallo no hay patrón: anunciarlo como tal infla un caso aislado.
  it('no anuncia patrón con un fallo solo', async () => {
    recent.push(fail())
    const wrapper = await mountDash()
    expect(wrapper.find('.pattern').exists()).toBe(false)
  })

  it('dos fallos de clases distintas tampoco son un patrón', async () => {
    recent.push(fail(), fail({ failureClass: 'budget_exhausted' }))
    const wrapper = await mountDash()
    expect(wrapper.find('.pattern').exists()).toBe(false)
  })

  // Un fallo sin clasificar no se mezcla con otro sólo por ser fallo.
  it('ignora los fallos sin failureClass', async () => {
    recent.push(fail({ failureClass: null }), fail({ failureClass: null }))
    const wrapper = await mountDash()
    expect(wrapper.find('.pattern').exists()).toBe(false)
  })

  // Sin los issues concretos el patrón no es accionable.
  it('lleva a los runs concretos', async () => {
    recent.push(fail(), fail())
    const wrapper = await mountDash()
    expect(wrapper.findAll('.pattern__task').length).toBeGreaterThanOrEqual(1)
  })
})
