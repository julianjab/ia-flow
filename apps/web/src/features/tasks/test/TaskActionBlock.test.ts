import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TaskActionBlock from '@/features/tasks/TaskActionBlock.vue'

describe('TaskActionBlock', () => {
  it('dibuja cuántos cambios hay propuestos, singular vs plural', () => {
    const one = mount(TaskActionBlock, { props: { actionsCount: 1 } })
    expect(one.find('.action-summary').text()).toBe('1 cambio propuesto')
    const many = mount(TaskActionBlock, { props: { actionsCount: 3 } })
    expect(many.find('.action-summary').text()).toBe('3 cambios propuestos')
  })

  it('Aplicar emite `apply`', async () => {
    const w = mount(TaskActionBlock, { props: { actionsCount: 1 } })
    await w.find('[data-testid="chat-apply"]').trigger('click')
    expect(w.emitted('apply')).toHaveLength(1)
    expect(w.emitted('discard')).toBeUndefined()
  })

  it('Descartar emite `discard`', async () => {
    const w = mount(TaskActionBlock, { props: { actionsCount: 1 } })
    await w.find('[data-testid="chat-discard"]').trigger('click')
    expect(w.emitted('discard')).toHaveLength(1)
    expect(w.emitted('apply')).toBeUndefined()
  })
})
