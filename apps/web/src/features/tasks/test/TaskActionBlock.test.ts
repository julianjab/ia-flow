import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TaskActionBlock from '@/features/tasks/TaskActionBlock.vue'

const actions = [
  {
    type: 'set-field' as const,
    itemId: 't1',
    itemTitle: 'Arreglar bug',
    field: 'status',
    value: 'Done',
  },
]

describe('TaskActionBlock', () => {
  it('dibuja un chip por acción con el campo y el valor propuesto', () => {
    const w = mount(TaskActionBlock, { props: { actions } })
    const chip = w.find('.action-chip')
    expect(chip.text()).toContain('Arreglar bug')
    expect(chip.text()).toContain('status')
    expect(chip.text()).toContain('Done')
  })

  it('Aplicar emite `apply` sin argumentos — el padre ya tiene las acciones por prop', async () => {
    const w = mount(TaskActionBlock, { props: { actions } })
    await w.find('[data-testid="chat-apply"]').trigger('click')
    expect(w.emitted('apply')).toHaveLength(1)
    expect(w.emitted('discard')).toBeUndefined()
  })

  it('Descartar emite `discard`', async () => {
    const w = mount(TaskActionBlock, { props: { actions } })
    await w.find('[data-testid="chat-discard"]').trigger('click')
    expect(w.emitted('discard')).toHaveLength(1)
    expect(w.emitted('apply')).toBeUndefined()
  })
})
