import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AssistantComposer from '../AssistantComposer.vue'

const tasks = [
  { ref: 'acme/api#7', title: 'Mergear el fix', group: 'need', kind: 'merge' },
  { ref: 'acme/web#12', title: 'Review sin aprobar', group: 'need', kind: 'review' },
] as never

function render() {
  return mount(AssistantComposer, {
    props: {
      placeholder: 'Preguntá…',
      streaming: false,
      scope: { kind: 'general' },
      tasks,
      projects: [{ id: 'core', board: { owner: 'acme', number: 1 } }],
    },
  })
}

describe('AssistantComposer', () => {
  it('# lista las tareas; elegir una cambia el contexto y saca el # de la caja', async () => {
    const w = render()
    const box = w.get('textarea')
    await box.setValue('¿qué pasa con #web')
    expect(w.findAll('[role="option"]').map((o) => o.text())).toEqual([
      expect.stringContaining('12 web'),
    ])
    await box.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('scope')).toEqual([[{ kind: 'task', ref: 'acme/web#12' }]])
    expect((box.element as HTMLTextAreaElement).value).toBe('¿qué pasa con ')
    expect(w.emitted('send')).toBeUndefined()
  })

  it('@ ofrece todo el runner y los proyectos', async () => {
    const w = render()
    await w.get('textarea').setValue('@')
    const labels = w.findAll('[role="option"]').map((o) => o.text())
    expect(labels[0]).toContain('General')
    expect(labels[1]).toContain('core')
    await w.get('[data-test="opt-core"]').trigger('click')
    expect(w.emitted('scope')).toEqual([[{ kind: 'project', project_id: 'core' }]])
  })

  it('una ref escrita entera vale aunque no esté en la bandeja', async () => {
    const w = render()
    await w.get('textarea').setValue('#otra/repo#99')
    expect(w.find('[data-test="opt-otra/repo#99"]').exists()).toBe(true)
  })

  it('tocar la chip de contexto abre la lista; sin # ni @, Enter envía', async () => {
    const w = render()
    await w.get('[data-test="scope"]').trigger('click')
    expect(w.findAll('[role="option"]').length).toBe(2)
    await w.get('textarea').setValue('hola')
    await w.get('textarea').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('send')).toEqual([['hola']])
  })
})
