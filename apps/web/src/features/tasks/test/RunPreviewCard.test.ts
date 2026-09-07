import TaskRunPreview from '@/features/tasks/TaskRunPreview.vue'
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
  const wrapper = mount(TaskRunPreview, {
    props: { projectId: 'ia-flow', taskId: 'I_1', ...props },
  })
  await flushPromises()
  return wrapper
}

describe('TaskRunPreview', () => {
  it('nombra la regla que va a tomar la tarea', async () => {
    const wrapper = await mountWith()
    expect(fetchTaskRunPreview).toHaveBeenCalledWith('ia-flow', 'I_1')
    expect(wrapper.get('.preview-line.is-ok').text()).toContain('ia-flow · build → implementer')
  })

  // El caso que motivó esto: el botón "no hace nada" y eso no se distingue de
  // un fallo. Decirlo antes de apretar es la mitad del valor.
  it('avisa cuando ninguna regla matchea, antes de apretar', async () => {
    fetchTaskRunPreview.mockResolvedValue(preview({ matched: [] }))
    const wrapper = await mountWith()
    expect(wrapper.get('.preview-line.is-warn').text()).toContain('Ninguna regla matchea')
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
    const text = wrapper.get('.preview-reject').text()
    expect(text).toContain('status = review')
    expect(text).toContain('es build')
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
    expect(wrapper.get('.preview-reject').text()).toContain('es —')
  })

  it('una regla apagada se explica como tal', async () => {
    fetchTaskRunPreview.mockResolvedValue(
      preview({ matched: [], rejected: [{ id: 'r', name: 'r', reason: 'disabled' }] }),
    )
    const wrapper = await mountWith()
    expect(wrapper.get('.preview-reject').text()).toContain('deshabilitada')
  })

  it('un run en curso se avisa aunque haya regla que matchee', async () => {
    fetchTaskRunPreview.mockResolvedValue(
      preview({ blockedReason: 'Ya hay un run en curso para esta tarea' }),
    )
    const wrapper = await mountWith()
    expect(wrapper.text()).toContain('run en curso')
  })

  // El preview es diagnóstico: si falla, no puede tapar el resto del detalle.
  it('un fallo al evaluar se degrada a una línea', async () => {
    fetchTaskRunPreview.mockRejectedValue(new Error('502'))
    const wrapper = await mountWith()
    expect(wrapper.get('.preview-line.is-dim').text()).toContain('502')
  })

  it('se reevalúa al cambiar de tarea', async () => {
    const wrapper = await mountWith()
    await wrapper.setProps({ taskId: 'I_2' })
    await flushPromises()
    expect(fetchTaskRunPreview).toHaveBeenLastCalledWith('ia-flow', 'I_2')
  })
})
