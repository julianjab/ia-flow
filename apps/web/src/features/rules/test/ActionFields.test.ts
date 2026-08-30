import ActionFields from '@/features/rules/ActionFields.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

type Entry = Record<string, unknown> & { action: string }

function mountFields(entry: Entry, agentIds?: string[]) {
  return mount(ActionFields, { props: { entry, agentIds } })
}

function lastPatch(wrapper: ReturnType<typeof mountFields>): Record<string, unknown> {
  return (wrapper.emitted('patch')?.at(-1)?.[0] ?? {}) as Record<string, unknown>
}

describe('ActionFields', () => {
  // Cada tipo muestra SÓLO lo suyo: es lo que hace que cambiar de tipo no
  // arrastre campos que el server rechaza.
  it('muestra los campos del tipo y ninguno del resto', () => {
    expect(mountFields({ action: 'emit' }).text()).toContain('Tipo de evento')
    expect(mountFields({ action: 'emit' }).text()).not.toContain('URL')
    expect(mountFields({ action: 'http' }).text()).toContain('URL')
    expect(mountFields({ action: 'ref' }).text()).toContain('Acción')
  })

  // Antes esto era un `<select>` cuando había lista y un `<input>` cuando no.
  // Ahora es un solo control: sugiere lo conocido y acepta lo que no —un
  // agente que todavía no se creó tiene que poder nombrarse igual.
  it('sugiere los agentes conocidos y acepta uno que no lo es', async () => {
    const conLista = mountFields({ action: 'agent' }, ['refiner'])
    await conLista.get('input').trigger('focus')
    expect(conLista.findAll('.cb-opt__label').map((e) => e.text())).toContain('refiner')

    const sinLista = mountFields({ action: 'agent' })
    await sinLista.get('input').setValue('todavia-no-existe')
    await sinLista.get('input').trigger('blur')
    expect(lastPatch(sinLista)).toEqual({ agentId: 'todavia-no-existe' })
  })

  // El body puede ser cualquier JSON. Se parsea si se puede, y si no se guarda
  // como string: un JSON a medio escribir no se pierde al cerrar el modal.
  it('el body parsea a objeto cuando es JSON válido', async () => {
    const wrapper = mountFields({ action: 'http' })
    await wrapper.find('textarea').setValue('{"pr": 1}')
    expect(lastPatch(wrapper)).toEqual({ body: { pr: 1 } })
  })

  it('un JSON a medio escribir se conserva como texto', async () => {
    const wrapper = mountFields({ action: 'http' })
    await wrapper.find('textarea').setValue('{"pr":')
    expect(lastPatch(wrapper)).toEqual({ body: '{"pr":' })
  })

  it('un body vacío borra el campo en vez de mandar un string vacío', async () => {
    const wrapper = mountFields({ action: 'http', body: { pr: 1 } })
    await wrapper.find('textarea').setValue('   ')
    expect(lastPatch(wrapper)).toEqual({ body: undefined })
  })

  it('un body que ya era objeto se muestra formateado', () => {
    const wrapper = mountFields({ action: 'http', body: { pr: 1 } })
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('{\n  "pr": 1\n}')
  })

  it('el método default es POST cuando la entrada no lo trae', () => {
    const wrapper = mountFields({ action: 'http' })
    expect((wrapper.find('select').element as HTMLSelectElement).value).toBe('POST')
  })
})
