import NextUpSection from '@/features/tasks/NextUpSection.vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// La cola ya NO se ordena acá: la disposición, su razón y el verbo los resuelve
// el server, porque dependen de las reglas de retry, los blockers y el PR — las
// tres cosas que el browser no tiene. Lo que queda para testear es lo que sí es
// de la UI: agrupar por bucket, congelar el orden y despachar el verbo.

const items: Array<Record<string, unknown>> = []
let dispositions: Array<Record<string, unknown>> = []
let dispositionsThrows = false

vi.mock('@/features/projects/store', () => ({
  useProjectsStore: () => ({ activeProjectId: 'p1' }),
}))
vi.mock('@/features/projects/sourceApi', () => ({
  fetchProjectItems: vi.fn(async () => ({ kind: 'github-issues', items })),
}))
const runTaskNow = vi.fn(async () => ({ outcome: 'dispatched', status: 'build' }))
vi.mock('@/features/tasks/api', () => ({
  fetchTaskDispositions: vi.fn(async () => {
    if (dispositionsThrows) throw new Error('502')
    return dispositions
  }),
  runTaskNow: (...a: unknown[]) => runTaskNow(...(a as [])),
}))
const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))
const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: toastSuccess, error: toastError }),
}))

function task(id: string) {
  return {
    id,
    title: `Tarea ${id}`,
    status: 'build',
    meta: { issueNumber: Number(id.slice(1)), issueUrl: `https://gh/${id}` },
  }
}

function entry(taskId: string, over: Record<string, unknown> = {}) {
  return {
    taskId,
    disposition: 'waiting-on-you',
    reason: 'falló · no hay regla de retry',
    waitingOnYouSince: null,
    unblocks: 0,
    blockedBy: [],
    verb: { label: 'Reintentar', kind: 'run' },
    ...over,
  }
}

beforeEach(() => {
  items.splice(0, items.length)
  dispositions = []
  dispositionsThrows = false
  push.mockClear()
  runTaskNow.mockClear()
})

async function mountWith() {
  const w = mount(NextUpSection)
  await flushPromises()
  await flushPromises()
  return w
}

describe('NextUpSection', () => {
  it('agrupa por bucket y no dibuja los vacíos', async () => {
    items.push(task('t1'), task('t2'))
    dispositions = [entry('t1'), entry('t2', { disposition: 'moving', verb: null })]
    const w = await mountWith()
    expect(w.find('[data-testid="bucket-waiting-on-you"]').exists()).toBe(true)
    expect(w.find('[data-testid="bucket-moving"]').exists()).toBe(true)
    // Un encabezado que cuenta cero es chrome que no informa (R10).
    expect(w.find('[data-testid="bucket-blocked"]').exists()).toBe(false)
  })

  it('la razón viaja con la fila (O1)', async () => {
    items.push(task('t1'))
    dispositions = [entry('t1', { reason: 'falló 2× · no hay regla de retry' })]
    const w = await mountWith()
    expect(w.text()).toContain('falló 2× · no hay regla de retry')
  })

  it('sólo el bucket 1 lleva verbo (O2)', async () => {
    items.push(task('t1'), task('t2'))
    dispositions = [
      entry('t1'),
      entry('t2', { disposition: 'blocked', reason: 'espera #99', verb: null }),
    ]
    const w = await mountWith()
    // Si no te toca, ofrecer un botón es ruido.
    expect(w.findAll('[data-testid="next-up-verb"]')).toHaveLength(1)
  })

  it('el verbo `external` abre el PR y NO promete mergear desde la app', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    items.push(task('t1'))
    dispositions = [
      entry('t1', {
        verb: {
          label: 'Revisar el PR',
          kind: 'external',
          href: 'https://gh/pull/1',
          hint: '↗ github',
        },
      }),
    ]
    const w = await mountWith()
    await w.get('[data-testid="next-up-verb"]').trigger('click')
    expect(open).toHaveBeenCalledWith('https://gh/pull/1', '_blank', 'noopener')
    expect(runTaskNow).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('el verbo `route` navega a la pantalla donde eso se hace hoy', async () => {
    items.push(task('t1'))
    dispositions = [
      entry('t1', {
        verb: { label: 'Resolver', kind: 'route', href: '/general/aborted-runs?run=e9' },
      }),
    ]
    const w = await mountWith()
    await w.get('[data-testid="next-up-verb"]').trigger('click')
    expect(push).toHaveBeenCalledWith('/general/aborted-runs?run=e9')
  })

  it('el verbo `run` llama al endpoint que existe', async () => {
    items.push(task('t1'))
    dispositions = [entry('t1')]
    const w = await mountWith()
    await w.get('[data-testid="next-up-verb"]').trigger('click')
    await flushPromises()
    expect(runTaskNow).toHaveBeenCalledWith('p1', 't1')
  })

  it('sin el agregado, dice que la cola está incompleta — no "no hay nada"', async () => {
    // Afirmar "nada te espera" sobre datos que nunca llegaron es peor que un
    // error, porque no se nota.
    items.push(task('t1'))
    dispositionsThrows = true
    const w = await mountWith()
    expect(w.text()).toContain('esta cola está incompleta')
    expect(w.text()).not.toContain('No hay tareas')
  })

  describe('el orden no se recalcula solo', () => {
    it('sin cambios de lugar no dibuja el aviso', async () => {
      items.push(task('t1'), task('t2'))
      dispositions = [entry('t1'), entry('t2')]
      const w = await mountWith()
      expect(w.find('[data-testid="next-up-reorder"]').exists()).toBe(false)
    })

    it('el server reordena, la pantalla NO se mueve y avisa', async () => {
      // Con el socket vivo, un orden que se recalcula solo mueve la fila que
      // ibas a tocar bajo el dedo. Reordenar es un gesto del usuario.
      items.push(task('t1'), task('t2'))
      dispositions = [entry('t1'), entry('t2')]
      const w = await mountWith()
      expect(w.findAll('.nu-title').map((n) => n.text())).toEqual([
        expect.stringContaining('Tarea t1'),
        expect.stringContaining('Tarea t2'),
      ])

      dispositions = [entry('t2'), entry('t1')]
      await w.get('.btn').trigger('click')
      await flushPromises()
      await flushPromises()

      // Sigue en el orden viejo…
      expect(w.findAll('.nu-title').map((n) => n.text())).toEqual([
        expect.stringContaining('Tarea t1'),
        expect.stringContaining('Tarea t2'),
      ])
      // …y lo dice.
      const banner = w.get('[data-testid="next-up-reorder"]')
      expect(banner.text()).toContain('2')

      await banner.trigger('click')
      expect(w.findAll('.nu-title').map((n) => n.text())).toEqual([
        expect.stringContaining('Tarea t2'),
        expect.stringContaining('Tarea t1'),
      ])
    })
  })
})
