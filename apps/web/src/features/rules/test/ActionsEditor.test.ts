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

function lastEmitted(wrapper: ReturnType<typeof mountEditor>): RuleActionEntry[] {
  const events = wrapper.emitted('update:modelValue')
  return (events?.at(-1)?.[0] ?? []) as RuleActionEntry[]
}

describe('ActionsEditor', () => {
  it('sólo ofrece los tipos que el daemon sabe ejecutar', () => {
    const wrapper = mountEditor(
      [{ action: 'agent', agentId: 'x' } as RuleActionEntry],
      ['agent', 'http'],
    )
    const options = wrapper.find('select.ae-kind').findAll('option')
    expect(options.map((o) => o.attributes('value'))).toEqual(['agent', 'http'])
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
    await wrapper.find('select.ae-kind').setValue('emit')
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
    await wrapper.find('select.ae-kind').setValue('emit')
    expect(lastEmitted(wrapper)[0]).toMatchObject({ action: 'emit', continueOnError: true })
  })

  it('reordena sin perder ninguna acción', async () => {
    const wrapper = mountEditor([
      { action: 'agent', agentId: 'a' } as RuleActionEntry,
      { action: 'agent', agentId: 'b' } as RuleActionEntry,
    ])
    // El segundo botón de subir (índice 1) — el primero está deshabilitado.
    const upButtons = wrapper.findAll('[aria-label="Subir"]')
    await upButtons[1].trigger('click')
    expect(lastEmitted(wrapper).map((a) => (a as { agentId: string }).agentId)).toEqual(['b', 'a'])
  })

  it('los botones de borde están deshabilitados', () => {
    const wrapper = mountEditor([
      { action: 'agent', agentId: 'a' } as RuleActionEntry,
      { action: 'agent', agentId: 'b' } as RuleActionEntry,
    ])
    expect(wrapper.findAll('[aria-label="Subir"]')[0].attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('[aria-label="Bajar"]')[1].attributes('disabled')).toBeDefined()
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
