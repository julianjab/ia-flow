import ActionFields from '@/features/rules/ActionFields.vue'
import JsonActionForm from '@/features/rules/actionForms/JsonActionForm.vue'
import ScriptActionForm from '@/features/rules/actionForms/ScriptActionForm.vue'
import {
  actionFormFor,
  blankActionFor,
  hasDedicatedForm,
} from '@/features/rules/actionForms/registry'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

type Entry = Record<string, unknown> & { action: string }

function mountFields(entry: Entry) {
  return mount(ActionFields, { props: { entry } })
}

function lastPatch(wrapper: ReturnType<typeof mountFields>): Record<string, unknown> {
  return (wrapper.emitted('patch')?.at(-1)?.[0] ?? {}) as Record<string, unknown>
}

describe('registry de forms de acción', () => {
  it('cada tipo del union tiene su form', () => {
    for (const kind of ['agent', 'http', 'emit', 'script', 'ref']) {
      expect(hasDedicatedForm(kind)).toBe(true)
    }
  })

  // El daemon publica los tipos que sabe ejecutar. Uno que la web todavía no
  // conoce tiene que quedar editable igual, o el operador ve una opción que no
  // se puede completar.
  it('un tipo desconocido cae al form JSON y conserva su tipo', () => {
    expect(actionFormFor('todavia-no-existe')).toBe(JsonActionForm)
    expect(blankActionFor('todavia-no-existe')).toEqual({ action: 'todavia-no-existe' })
  })

  it('el blanco de cada tipo trae sus campos obligatorios', () => {
    expect(blankActionFor('script')).toEqual({ action: 'script', runtime: 'bash', file: '' })
    expect(blankActionFor('http')).toEqual({ action: 'http', method: 'POST', url: '' })
    expect(blankActionFor('agent', { agentId: 'refiner' })).toEqual({
      action: 'agent',
      agentId: 'refiner',
    })
  })
})

describe('ScriptActionForm', () => {
  it('lo edita el form de script y no el fallback JSON', () => {
    expect(actionFormFor('script')).toBe(ScriptActionForm)
    expect(mountFields({ action: 'script' }).text()).toContain('Archivo')
  })

  // La guarda real está en el adapter, pero una ruta absoluta se ve acá: el
  // server la rechazaría recién al guardar, sin decir cuál de las acciones fue.
  it('avisa cuando la ruta es absoluta', () => {
    expect(mountFields({ action: 'script', file: '/etc/passwd' }).text()).toContain(
      'relativa al repo',
    )
    expect(mountFields({ action: 'script', file: 'scripts/x.sh' }).text()).not.toContain(
      'relativa al repo',
    )
  })

  it('agrega y quita argumentos', async () => {
    const wrapper = mountFields({ action: 'script', args: ['uno'] })
    await wrapper.get('button.ff-add').trigger('click')
    expect(lastPatch(wrapper)).toEqual({ args: ['uno', ''] })

    const conDos = mountFields({ action: 'script', args: ['uno', 'dos'] })
    await conDos.findAll('button.ff-drop')[0].trigger('click')
    expect(lastPatch(conDos)).toEqual({ args: ['dos'] })
  })

  // Una lista vacía no es lo mismo que "sin argumentos": el schema los quiere
  // ausentes, no como `[]`.
  it('quitar el último argumento borra el campo', async () => {
    const wrapper = mountFields({ action: 'script', args: ['uno'] })
    await wrapper.get('button.ff-drop').trigger('click')
    expect(lastPatch(wrapper)).toEqual({ args: undefined })
  })

  it('el env se edita como pares y se guarda como record', async () => {
    const wrapper = mountFields({ action: 'script', env: { PR: 'viejo' } })
    await wrapper.findAll('input.ff-list-val')[0].setValue('{{event.payload.pr.url}}')
    expect(lastPatch(wrapper)).toEqual({ env: { PR: '{{event.payload.pr.url}}' } })
  })
})

describe('JsonActionForm', () => {
  // Un patch sólo mergea: sin los `undefined` explícitos, un campo borrado del
  // JSON seguiría en la acción guardada.
  it('un campo sacado del JSON se borra en vez de sobrevivir al merge', async () => {
    const wrapper = mountFields({ action: 'raro', a: 1, b: 2 })
    await wrapper.get('textarea').setValue('{"a": 1}')
    expect(lastPatch(wrapper)).toEqual({ a: 1, b: undefined })
  })

  it('no ofrece editar el tipo, que lo cambia el selector de arriba', () => {
    const wrapper = mountFields({ action: 'raro', a: 1 })
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).not.toContain('action')
  })
})

describe('AgentActionForm', () => {
  it('publicar el resultado como evento habilita el tipo del evento', async () => {
    const off = mountFields({ action: 'agent', agentId: 'x' })
    expect(off.text()).not.toContain('Tipo del evento')
    await off.get('input[type="checkbox"]').setValue(true)
    expect(lastPatch(off)).toEqual({ emitOn: 'exit' })

    const on = mountFields({ action: 'agent', agentId: 'x', emitOn: 'exit' })
    expect(on.text()).toContain('Tipo del evento')
    await on.get('input[type="checkbox"]').setValue(false)
    expect(lastPatch(on)).toEqual({ emitOn: undefined, emitType: undefined })
  })
})

describe('EmitActionForm', () => {
  it('el ámbito vacío se borra en vez de guardarse como objeto vacío', async () => {
    const wrapper = mountFields({ action: 'emit', type: 'x', scope: { projectId: 'ia-flow' } })
    await wrapper.get('details input').setValue('')
    expect(lastPatch(wrapper)).toEqual({ scope: undefined })
  })

  it('los repos se escriben separados por coma', async () => {
    const wrapper = mountFields({ action: 'emit', type: 'x' })
    await wrapper.findAll('details input')[1].setValue('uno, otro')
    expect(lastPatch(wrapper)).toEqual({ scope: { repos: ['uno', 'otro'] } })
  })
})

describe('HttpActionForm', () => {
  it('los headers se editan como pares', async () => {
    const wrapper = mountFields({ action: 'http', url: 'x', headers: { Authorization: '' } })
    await wrapper.get('input.ff-list-val').setValue('Bearer ${T}')
    expect(lastPatch(wrapper)).toEqual({ headers: { Authorization: 'Bearer ${T}' } })
  })

  it('un timeout vacío no se guarda como cero', async () => {
    const wrapper = mountFields({ action: 'http', url: 'x', timeoutMs: 5000 })
    await wrapper.get('input[type="number"]').setValue('')
    expect(lastPatch(wrapper)).toEqual({ timeoutMs: undefined })
  })
})
