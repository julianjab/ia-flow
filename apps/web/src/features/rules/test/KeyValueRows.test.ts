import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import KeyValueRows from '../actionForms/KeyValueRows.vue'

function many(n: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`VAR_${i}`, `valor-${i}`]))
}

describe('KeyValueRows — editar es un modo (R11)', () => {
  it('con pocas filas monta los campos directo: el toggle no ahorraría nada', () => {
    const w = mount(KeyValueRows, { props: { modelValue: many(3) } })
    expect(w.findAll('input.ff-field')).toHaveLength(6)
    expect(w.find('[data-testid="kvr-edit"]').exists()).toBe(false)
  })

  it('pasado el umbral arranca en lectura — sin campos y sin ✕', () => {
    // Veinte pares con campos montados son 1804px de formulario que hay que
    // scrollear entero para llegar a Guardar, cuando lo que se venía a hacer
    // era mirar si una clave está puesta.
    const w = mount(KeyValueRows, { props: { modelValue: many(12) } })
    expect(w.findAll('input.ff-field')).toHaveLength(0)
    expect(w.findAll('.ff-drop')).toHaveLength(0)
    expect(w.findAll('.kvr-read')).toHaveLength(12)
  })

  it('`editar` monta los campos y el ✕', async () => {
    const w = mount(KeyValueRows, { props: { modelValue: many(12) } })
    await w.get('[data-testid="kvr-edit"]').trigger('click')
    expect(w.findAll('input.ff-field')).toHaveLength(24)
    expect(w.findAll('.ff-drop')).toHaveLength(12)
  })

  it('un valor secreto no se lee de un vistazo', () => {
    const w = mount(KeyValueRows, { props: { modelValue: many(12), secret: true } })
    expect(w.text()).not.toContain('valor-0')
    expect(w.text()).toContain('••••••••')
  })

  it('agregar entra en edición: no tendría sentido una clave que no se escribe', async () => {
    const w = mount(KeyValueRows, { props: { modelValue: many(12) } })
    await w.get('[data-testid="kvr-edit"]').trigger('click')
    await w.get('button.ff-add').trigger('click')
    const emitted = w.emitted('update:modelValue')?.at(-1)?.[0] as Record<string, string>
    expect(Object.keys(emitted)).toHaveLength(13)
  })

  it('`+ <ítem>` es la última fila y nombra lo que agrega', async () => {
    const w = mount(KeyValueRows, { props: { modelValue: many(2), addLabel: '+ header' } })
    const add = w.get('button.ff-add')
    expect(add.text()).toBe('+ header')
    // Última: lo nuevo entra arriba, el control no se mueve de lugar.
    const children = Array.from(w.get('.ff-list').element.children)
    expect(children.at(-1)).toBe(add.element)
  })
})
