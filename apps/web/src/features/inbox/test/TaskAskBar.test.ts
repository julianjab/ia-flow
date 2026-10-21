import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import TaskAskBar from '@/features/inbox/TaskAskBar.vue'
import { useAssistantStore } from '@/stores/assistant'

beforeEach(() => setActivePinia(createPinia()))

describe('TaskAskBar', () => {
  it('lo escrito abre el asistente en el contexto de la tarea, con la pregunta lista para mandar', async () => {
    const w = mount(TaskAskBar, { props: { taskRef: 'acme/api#7' } })
    await w.get('input').setValue('¿por qué falló?')
    expect(w.get('button').attributes('aria-label')).toBe('Enviar al asistente')
    await w.get('form').trigger('submit')

    const ui = useAssistantStore()
    expect(ui.isOpen).toBe(true)
    expect(ui.consumeRequest()).toEqual({ kind: 'task', ref: 'acme/api#7' })
    expect(ui.consumeMessage()).toBe('¿por qué falló?')
    expect((w.get('input').element as HTMLInputElement).value).toBe('')
  })

  it('vacía, sólo abre el asistente en ese contexto', async () => {
    const w = mount(TaskAskBar, { props: { taskRef: 'acme/api#7' } })
    expect(w.get('button').attributes('aria-label')).toBe('Abrir el asistente')
    await w.get('form').trigger('submit')

    const ui = useAssistantStore()
    expect(ui.isOpen).toBe(true)
    expect(ui.consumeRequest()).toEqual({ kind: 'task', ref: 'acme/api#7' })
    expect(ui.consumeMessage()).toBeNull()
  })
})
