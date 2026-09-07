import RunPreviewCard from '@/features/tasks/RunPreviewCard.vue'
import type { TaskRunPreview as Preview } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchTaskRunPreview = vi.fn()
vi.mock('@/features/tasks/api', () => ({
  fetchTaskRunPreview: (...args: unknown[]) => fetchTaskRunPreview(...(args as [])),
}))

const preview = (over: Partial<Preview> = {}): Preview => ({
  status: 'build',
  blockedReason: null,
  matched: [{ id: 'ia-flow-build', name: 'ia-flow · build → implementer' }],
  rejected: [],
  notApplicable: 0,
  ...over,
})

beforeEach(() => {
  fetchTaskRunPreview.mockReset()
  fetchTaskRunPreview.mockResolvedValue(preview())
})

async function mountWith(props: Record<string, unknown> = {}) {
  const wrapper = mount(RunPreviewCard, {
    props: { projectId: 'ia-flow', taskId: 'I_1', ...props },
  })
  await flushPromises()
  return wrapper
}

describe('RunPreviewCard', () => {
  it('nombra la regla que va a tomar la tarea', async () => {
    const wrapper = await mountWith()
    expect(fetchTaskRunPreview).toHaveBeenCalledWith('ia-flow', 'I_1')
    expect(wrapper.get('.rpc-line.is-ok').text()).toContain('ia-flow · build → implementer')
    // Si la toma alguna regla, esta vista no aplica: no hay nada que explicar.
    expect(wrapper.find('.rpc-state').exists()).toBe(false)
  })

  // El caso que motivó esto: el botón "no hace nada" y eso no se distingue de
  // un fallo. Decirlo antes de apretar es la mitad del valor.
  it('la tarjeta de estado dice el veredicto y cuántas reglas se evaluaron', async () => {
    fetchTaskRunPreview.mockResolvedValue(
      preview({
        matched: [],
        notApplicable: 14,
        rejected: [{ id: 'r1', name: 'r1', reason: 'when', failed: [] }],
      }),
    )
    const wrapper = await mountWith()
    const state = wrapper.get('.rpc-state')
    expect(state.text()).toContain('Nunca se ejecutó')
    expect(state.text()).toContain('1 evaluada')
    expect(state.text()).toContain('14 no aplican')
  })

  it('una card por regla, con su motivo de descarte', async () => {
    fetchTaskRunPreview.mockResolvedValue(
      preview({
        matched: [],
        rejected: [
          { id: 'a', name: 'ia-flow · build', reason: 'when', failed: [] },
          { id: 'b', name: 'ia-flow · review', reason: 'exclusive' },
        ],
      }),
    )
    const wrapper = await mountWith()
    const cards = wrapper.findAll('.rpc-card')
    expect(cards).toHaveLength(2)
    expect(cards[0].get('.rpc-name').text()).toBe('ia-flow · build')
    expect(cards[1].get('.rpc-reason').text()).toBe('exclusive')
  })

  it('muestra la condición que falló con el valor real al lado', async () => {
    fetchTaskRunPreview.mockResolvedValue(
      preview({
        matched: [],
        rejected: [
          {
            id: 'ia-flow-review',
            name: 'ia-flow · review',
            reason: 'when',
            failed: [{ field: 'status', op: '=', value: 'review', actual: 'build' }],
          },
        ],
      }),
    )
    const wrapper = await mountWith()
    const cond = wrapper.get('.rpc-cond')
    expect(cond.get('.rpc-field').text()).toBe('status')
    expect(cond.get('.rpc-expected').text()).toBe('review')
    // El valor real de la tarea, en la ranura del fallo.
    expect(cond.get('.rpc-actual').text()).toBe('build')
  })

  // Un campo ausente en el evento es un problema distinto de "vino otro
  // valor", y colapsarlos obliga a leer el daemon.log.
  it('un campo que el evento no trae se muestra como —', async () => {
    fetchTaskRunPreview.mockResolvedValue(
      preview({
        matched: [],
        rejected: [
          {
            id: 'r',
            name: 'r',
            reason: 'when',
            failed: [{ field: 'pr.number', op: '=', value: '5', actual: null }],
          },
        ],
      }),
    )
    const wrapper = await mountWith()
    // `sin valor` y no un guion: que el evento no traiga el campo es otro
    // problema que "trae otro valor", y es el error de config más común.
    expect(wrapper.get('.rpc-missing').text()).toBe('sin valor')
    expect(wrapper.find('.rpc-actual').exists()).toBe(false)
  })

  // Sin la línea de dónde se prende, "no se puede" es un callejón sin salida
  // — misma regla que los ScopeGroup heredados.
  it('una regla apagada dice dónde se prende', async () => {
    fetchTaskRunPreview.mockResolvedValue(
      preview({ matched: [], rejected: [{ id: 'r', name: 'r', reason: 'disabled' }] }),
    )
    const wrapper = await mountWith()
    expect(wrapper.get('.rpc-cond-empty').text()).toContain('deshabilitada')
    expect(wrapper.get('.rpc-action').text()).toContain('General → Pipeline')
  })

  // La sugerencia sale de las condiciones que fallaron, no de un texto fijo.
  it('sugiere la acción que haría matchear alguna regla', async () => {
    fetchTaskRunPreview.mockResolvedValue(
      preview({
        matched: [],
        rejected: [
          {
            id: 'r',
            name: 'r',
            reason: 'when',
            failed: [{ field: 'status', op: '=', value: 'refine', actual: 'draft' }],
          },
        ],
      }),
    )
    const wrapper = await mountWith()
    expect(wrapper.get('.rpc-action').text()).toContain('mover a')
    expect(wrapper.get('.rpc-action').text()).toContain('refine')
  })

  // De un `!=` no sale una acción concreta: decir algo igual sería inventarlo.
  it('sin nada derivable no inventa una sugerencia', async () => {
    fetchTaskRunPreview.mockResolvedValue(
      preview({
        matched: [],
        rejected: [
          {
            id: 'r',
            name: 'r',
            reason: 'when',
            failed: [{ field: 'labels', op: '!=', value: 'epic', actual: 'epic' }],
          },
        ],
      }),
    )
    const wrapper = await mountWith()
    expect(wrapper.find('.rpc-action').exists()).toBe(false)
  })

  it('un run en curso se avisa aunque haya regla que matchee', async () => {
    fetchTaskRunPreview.mockResolvedValue(
      preview({ blockedReason: 'Ya hay un run en curso para esta tarea' }),
    )
    const wrapper = await mountWith()
    expect(wrapper.text()).toContain('run en curso')
  })

  it('un fallo al evaluar se degrada a una línea', async () => {
    fetchTaskRunPreview.mockRejectedValue(new Error('502'))
    const wrapper = await mountWith()
    expect(wrapper.get('.rpc-line.is-dim').text()).toContain('502')
  })

  it('se reevalúa al cambiar de tarea', async () => {
    const wrapper = await mountWith()
    await wrapper.setProps({ taskId: 'I_2' })
    await flushPromises()
    expect(fetchTaskRunPreview).toHaveBeenLastCalledWith('ia-flow', 'I_2')
  })
})
