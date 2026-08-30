import RuleScopeEditor from '@/features/rules/RuleScopeEditor.vue'
import type { ConditionRow } from '@/ui/condition-rows'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

const OPS = [
  { value: '=', label: '= igual' },
  { value: '!=', label: '!= distinto' },
]

const row = (over: Partial<ConditionRow> = {}): ConditionRow =>
  ({ field: 'status', op: '=', value: 'Todo', ...over }) as ConditionRow

function mountEditor(props: Record<string, unknown> = {}) {
  return mount(RuleScopeEditor, {
    props: {
      ops: OPS,
      repoName: '',
      whenRows: [] as ConditionRow[],
      whenText: '',
      schedule: '',
      logics: [] as Array<'and' | 'or'>,
      ...props,
    },
  })
}

describe('RuleScopeEditor', () => {
  // El ámbito no se edita acá: lo fija la sección desde la que se abrió el
  // modal, para que guardar no pueda promover una regla de proyecto a global.
  it('explica el alcance según venga o no un proyecto', () => {
    expect(mountEditor({ projectId: 'p1' }).text()).toContain('sólo a eventos del proyecto')
    expect(mountEditor().text()).toContain('Regla global')
  })

  // Una regla global no tiene repo contra el cual filtrar.
  it('el selector de repo sólo aparece dentro de un proyecto', () => {
    expect(mountEditor().text()).not.toContain('Repo')
    expect(mountEditor({ projectId: 'p1' }).text()).toContain('Repo')
  })

  it('cae a un input libre cuando no hay repos conocidos', () => {
    const conLista = mountEditor({ projectId: 'p1', repoNames: ['web', 'api'] })
    expect(conLista.find('select').exists()).toBe(true)

    const sinLista = mountEditor({ projectId: 'p1' })
    expect(sinLista.find('select').exists()).toBe(false)
  })

  // El conector se preserva por índice: una regla guardada con un OR tiene que
  // volver siendo la misma.
  it('el botón de conector alterna AND/OR y lo emite por índice', async () => {
    const wrapper = mountEditor({ whenRows: [row(), row({ field: 'type' })], logics: [] })

    const botones = wrapper.findAll('.rse-logic')
    expect(botones).toHaveLength(1)
    expect(botones[0]?.text()).toBe('AND')

    await botones[0]?.trigger('click')
    expect(wrapper.emitted('update:logics')?.at(-1)?.[0]).toEqual([undefined, 'or'])
  })

  it('con una sola condición no hay conector que elegir', () => {
    expect(mountEditor({ whenRows: [row()] }).findAll('.rse-logic')).toHaveLength(0)
  })
})
