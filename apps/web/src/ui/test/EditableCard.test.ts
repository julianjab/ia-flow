import EditableCard from '@/ui/EditableCard.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

describe('EditableCard', () => {
  it('la fila entera abre el editor cuando es clickable', async () => {
    const w = mount(EditableCard, { props: { clickable: true } })
    await w.find('.editable-card').trigger('click')
    expect(w.emitted('edit')).toHaveLength(1)
  })

  it('sin clickable, el click no abre nada — la lista lo edita por otro lado', async () => {
    const w = mount(EditableCard)
    await w.find('.editable-card').trigger('click')
    expect(w.emitted('edit')).toBeUndefined()
  })

  it('Enter y espacio sobre la fila abren el editor', async () => {
    const w = mount(EditableCard, { props: { clickable: true } })
    await w.find('.editable-card').trigger('keydown', { key: 'Enter' })
    await w.find('.editable-card').trigger('keydown', { key: ' ' })
    expect(w.emitted('edit')).toHaveLength(2)
  })

  // El bug que motivó el handler: `@keydown.space.prevent` en el template corre
  // el `preventDefault()` ANTES de mirar si la fila es clickable, y el keydown
  // burbujea desde el contenido del slot. ToolsSection mete un <textarea>
  // adentro de una card no clickable: no se podía escribir un espacio.
  it('no le come el espacio a un campo anidado', async () => {
    const w = mount(EditableCard, {
      slots: { default: '<textarea class="anidado"></textarea>' },
    })
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    w.find('.anidado').element.dispatchEvent(ev)

    expect(ev.defaultPrevented).toBe(false)
    expect(w.emitted('edit')).toBeUndefined()
  })

  // `@click.stop` en el contenedor de acciones frena el mouse, no el teclado.
  it('el teclado sobre un botón de acciones no abre el editor de paso', async () => {
    const w = mount(EditableCard, {
      props: { clickable: true },
      slots: { actions: '<button class="op">Deshabilitar</button>' },
    })
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    w.find('.op').element.dispatchEvent(ev)

    expect(ev.defaultPrevented).toBe(false)
    expect(w.emitted('edit')).toBeUndefined()
  })

  // Borrar vive en la vista de edición, no en el listado: sólo lo prende una
  // lista que no tenga detalle donde ponerlo.
  it('el ✕ es opt-in', async () => {
    expect(mount(EditableCard).find('.ec-btn--danger').exists()).toBe(false)

    const w = mount(EditableCard, { props: { deletable: true } })
    await w.find('.ec-btn--danger').trigger('click')
    expect(w.emitted('delete')).toHaveLength(1)
  })

  // Derivarlo de `!clickable` ofrecía el camino al detalle justo donde no hay
  // permiso para editar (un deploy por YAML), y encima era inalcanzable: Vue
  // castea un prop `Boolean` ausente a `false`, nunca a `undefined`.
  it('el botón "Editar" es opt-in, no derivado de clickable', async () => {
    expect(mount(EditableCard).find('.ec-btn').exists()).toBe(false)

    const w = mount(EditableCard, { props: { showEditButton: true } })
    await w.find('.ec-btn').trigger('click')
    expect(w.emitted('edit')).toHaveLength(1)
  })
})
