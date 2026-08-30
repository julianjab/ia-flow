import InlineEdit from '@/ui/InlineEdit.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

const LARGO = 'Read the contents of a file in one of the task repos. Use "<repo>/path" format.'

// Abrir/cerrar lo maneja el padre (`v-model:open`) desde que la fila entera
// abre la edición, así que el harness hace de padre: refleja `update:open` en
// el prop, que es lo que hace `v-model` en el componente real.
const mountIE = (props: Record<string, unknown> = {}) => {
  const w = mount(InlineEdit, {
    props: {
      modelValue: LARGO,
      open: false,
      'onUpdate:open': (v: boolean) => w.setProps({ open: v }),
      ...props,
    },
    attachTo: document.body,
  })
  return w
}

describe('InlineEdit', () => {
  it('arranca colapsado, en una línea, con el texto completo en el title', () => {
    const w = mountIE()
    const col = w.find('.ie-collapsed')

    expect(col.exists()).toBe(true)
    expect(w.find('textarea').exists()).toBe(false)
    // El title es lo que hace legible lo truncado sin abrir.
    expect(col.attributes('title')).toBe(LARGO)
  })

  // Un párrafo en un `<input>` sólo se puede editar por el extremo que se ve.
  it('al abrir usa un textarea, no un input', async () => {
    const w = mountIE()
    await w.find('.ie-collapsed').trigger('click')

    expect(w.find('textarea').exists()).toBe(true)
    expect(w.find('input').exists()).toBe(false)
    expect((w.find('textarea').element as HTMLTextAreaElement).value).toBe(LARGO)
  })

  it('guardar emite el valor nuevo', async () => {
    const w = mountIE()
    await w.find('.ie-collapsed').trigger('click')
    await w.find('textarea').setValue('Otra cosa')
    await w.find('.ie-ops .btn--primary').trigger('click')

    expect(w.emitted('save')?.[0]).toEqual(['Otra cosa'])
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['Otra cosa'])
    // Y vuelve a colapsarse.
    expect(w.find('textarea').exists()).toBe(false)
  })

  it('cancelar descarta y no emite el valor', async () => {
    const w = mountIE()
    await w.find('.ie-collapsed').trigger('click')
    await w.find('textarea').setValue('descartado')
    await w.findAll('.ie-ops .btn')[0].trigger('click')

    expect(w.emitted('save')).toBeUndefined()
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.find('.ie-collapsed').attributes('title')).toBe(LARGO)
  })

  // Al revés que en un input de una línea, y tiene que serlo: si Enter guardara
  // no habría forma de escribir el segundo renglón de un párrafo.
  it('Enter hace salto de línea; guarda con Cmd/Ctrl+Enter', async () => {
    const w = mountIE()
    await w.find('.ie-collapsed').trigger('click')

    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('save')).toBeUndefined()

    await w.find('textarea').trigger('keydown', { key: 'Enter', metaKey: true })
    expect(w.emitted('save')).toHaveLength(1)
  })

  it('Escape cancela', async () => {
    const w = mountIE()
    await w.find('.ie-collapsed').trigger('click')
    await w.find('textarea').trigger('keydown', { key: 'Escape' })

    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.find('textarea').exists()).toBe(false)
  })

  // Guardar vacío borraría la descripción de una tool sin que nadie lo pida.
  it('no guarda vacío', async () => {
    const w = mountIE()
    await w.find('.ie-collapsed').trigger('click')
    await w.find('textarea').setValue('   ')

    expect((w.find('.ie-ops .btn--primary').element as HTMLButtonElement).disabled).toBe(true)
    await w.find('.ie-ops .btn--primary').trigger('click')
    expect(w.emitted('save')).toBeUndefined()
  })

  it('en sólo lectura no abre', async () => {
    const w = mountIE({ disabled: true })
    await w.find('.ie-collapsed').trigger('click')
    expect(w.find('textarea').exists()).toBe(false)
  })

  // Si el valor cambia por fuera (un refetch) mientras alguien escribe,
  // pisarle lo tipeado sería perder trabajo sin aviso.
  it('un cambio externo no pisa lo que se está escribiendo', async () => {
    const w = mountIE()
    await w.find('.ie-collapsed').trigger('click')
    await w.find('textarea').setValue('a medio escribir')

    await w.setProps({ modelValue: 'llego del server' })
    expect((w.find('textarea').element as HTMLTextAreaElement).value).toBe('a medio escribir')
  })

  it('pero sí lo toma cuando está cerrado', async () => {
    const w = mountIE()
    await w.setProps({ modelValue: 'nuevo' })
    expect(w.find('.ie-collapsed').text()).toBe('nuevo')
  })

  it('sin valor muestra el placeholder', () => {
    const w = mountIE({ modelValue: '', placeholder: 'Sin descripción' })
    expect(w.find('.ie-collapsed').text()).toBe('Sin descripción')
  })
})
