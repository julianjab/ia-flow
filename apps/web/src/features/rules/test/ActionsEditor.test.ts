import ActionsEditor from '@/features/rules/ActionsEditor.vue'
import type { RuleActionEntry } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

function mountEditor(
  modelValue: RuleActionEntry[] = [],
  availableKinds = ['agent', 'http', 'emit'],
) {
  return mount(ActionsEditor, { props: { modelValue, availableKinds } })
}

/** El tipo se elige en un ComboBox: abrir el menú y clickear la opción. Un
 *  `select.setValue` ya no aplica — el desplegable nativo lo dibujaba el SO. */
async function pickKind(wrapper: ReturnType<typeof mountEditor>, kind: string) {
  await wrapper.find('.ae-kind input').trigger('focus')
  const opt = wrapper
    .findAll('.ae-kind .cb-opt')
    .find((o) => o.find('.cb-opt__hint').text() === kind)
  await opt?.trigger('click')
}

function lastEmitted(wrapper: ReturnType<typeof mountEditor>): RuleActionEntry[] {
  const events = wrapper.emitted('update:modelValue')
  return (events?.at(-1)?.[0] ?? []) as RuleActionEntry[]
}

describe('ActionsEditor', () => {
  it('sólo ofrece los tipos que el daemon sabe ejecutar', async () => {
    const wrapper = mountEditor(
      [{ action: 'agent', agentId: 'x' } as RuleActionEntry],
      ['agent', 'http'],
    )
    await wrapper.find('.ae-kind input').trigger('focus')
    const options = wrapper.findAll('.ae-kind .cb-opt__hint')
    expect(options.map((o) => o.text())).toEqual(['agent', 'http'])
  })

  it('una acción nueva nace con los campos obligatorios de su tipo', async () => {
    // Sin esto el form arranca en un estado que el server rechaza, y el
    // operador se entera recién al guardar.
    const wrapper = mountEditor([], ['http'])
    await wrapper.find('.ae-add').trigger('click')
    expect(lastEmitted(wrapper)[0]).toEqual({ action: 'http', url: '', method: 'POST' })
  })

  it('cambiar el tipo REEMPLAZA la entrada en vez de arrastrar campos ajenos', async () => {
    // Los campos de una http no significan nada en una emit; arrastrarlos
    // dejaría basura invisible en el form que el server rechaza.
    const wrapper = mountEditor([
      { action: 'http', url: 'https://x', method: 'POST' } as RuleActionEntry,
    ])
    await pickKind(wrapper, 'emit')
    expect(lastEmitted(wrapper)[0]).toEqual({ action: 'emit', type: '' })
  })

  it('conserva continueOnError al cambiar de tipo', async () => {
    const wrapper = mountEditor([
      {
        action: 'http',
        url: 'https://x',
        method: 'POST',
        continueOnError: true,
      } as RuleActionEntry,
    ])
    await pickKind(wrapper, 'emit')
    expect(lastEmitted(wrapper)[0]).toMatchObject({ action: 'emit', continueOnError: true })
  })

  it('arrastrar una acción sobre otra reordena sin perder ninguna', async () => {
    const wrapper = mountEditor([
      { action: 'agent', agentId: 'a' } as RuleActionEntry,
      { action: 'agent', agentId: 'b' } as RuleActionEntry,
    ])
    const heads = wrapper.findAll('.ae-head')
    await heads[1].trigger('dragstart', { dataTransfer: { setData() {} } })
    await wrapper.findAll('.ae-card')[0].trigger('drop')
    expect(lastEmitted(wrapper).map((a) => (a as { agentId: string }).agentId)).toEqual(['b', 'a'])
  })

  it('soltar sobre la misma acción no emite nada', async () => {
    const wrapper = mountEditor([
      { action: 'agent', agentId: 'a' } as RuleActionEntry,
      { action: 'agent', agentId: 'b' } as RuleActionEntry,
    ])
    await wrapper.findAll('.ae-head')[1].trigger('dragstart', { dataTransfer: { setData() {} } })
    await wrapper.findAll('.ae-card')[1].trigger('drop')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  /** Arrastrar no existe sin mouse, y el orden de las acciones es parte del
   *  contrato de la regla: el handle es un botón y las flechas lo mueven. */
  it('el handle mueve con el teclado', async () => {
    const wrapper = mountEditor([
      { action: 'agent', agentId: 'a' } as RuleActionEntry,
      { action: 'agent', agentId: 'b' } as RuleActionEntry,
    ])
    await wrapper.findAll('.ae-drag')[1].trigger('keydown', { key: 'ArrowUp' })
    expect(lastEmitted(wrapper).map((a) => (a as { agentId: string }).agentId)).toEqual(['b', 'a'])
  })

  it('con una sola acción no hay nada que reordenar', () => {
    const wrapper = mountEditor([{ action: 'agent', agentId: 'a' } as RuleActionEntry])
    expect(wrapper.find('.ae-drag').exists()).toBe(false)
    expect(wrapper.get('.ae-head').attributes('draggable')).toBe('false')
  })

  it('un body JSON inválido se guarda como texto en vez de perderse', async () => {
    // Un JSON a medio escribir no debería desaparecer al cerrar el modal.
    const wrapper = mountEditor([
      { action: 'http', url: 'https://x', method: 'POST' } as RuleActionEntry,
    ])
    await wrapper.find('textarea').setValue('{ "a": ')
    expect(lastEmitted(wrapper)[0]).toMatchObject({ body: '{ "a": ' })
  })

  it('un body JSON válido se guarda parseado', async () => {
    const wrapper = mountEditor([
      { action: 'http', url: 'https://x', method: 'POST' } as RuleActionEntry,
    ])
    await wrapper.find('textarea').setValue('{"pr": 1}')
    expect(lastEmitted(wrapper)[0]).toMatchObject({ body: { pr: 1 } })
  })

  it('avisa cuando la regla no tiene acciones', () => {
    expect(mountEditor([]).find('.ae-empty').exists()).toBe(true)
  })
})
