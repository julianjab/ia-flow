import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DataRow from '@/components/DataRow.vue'

const slots = {
  glyph: '<i class="g">✕</i>',
  identity: '<b class="i">Agregar SID</b>',
  state: '<em class="s">falló · tests</em>',
}

describe('DataRow', () => {
  it('dibuja las tres zonas', () => {
    const w = mount(DataRow, { props: { columns: '20px 1fr 7ch' }, slots })
    expect(w.find('.g').exists()).toBe(true)
    expect(w.find('.i').exists()).toBe(true)
    expect(w.find('.s').exists()).toBe(true)
  })

  it('las columnas llegan por variable, no hardcodeadas', () => {
    // Es lo que permite que cada tabla tenga las suyas sin que el componente
    // sepa de qué dominio es.
    const w = mount(DataRow, { props: { columns: '16px 1fr 13ch' }, slots })
    expect(w.attributes('style')).toContain('16px 1fr 13ch')
  })

  it('sin `clickable` no es un botón ni toma foco', () => {
    // Una fila de sólo lectura es grilla: no se toca, así que no toma --tap-h
    // ni entra en el orden de tabulación.
    const w = mount(DataRow, { props: { columns: '1fr' }, slots })
    expect(w.attributes('role')).toBeUndefined()
    expect(w.attributes('tabindex')).toBeUndefined()
  })

  it('con `clickable` abre por click y por teclado', async () => {
    const w = mount(DataRow, { props: { columns: '1fr', clickable: true }, slots })
    await w.trigger('click')
    await w.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('open')).toHaveLength(2)
  })

  it('una tecla sobre un control anidado NO abre la fila', async () => {
    // Sin este gate, un espacio sobre un botón de adentro abre el detalle EN
    // VEZ de activar el botón — el mismo bug que costó caro en EditableCard.
    const w = mount(DataRow, {
      props: { columns: '1fr', clickable: true },
      slots: { ...slots, default: '<button class="inner">x</button>' },
    })
    await w.get('.inner').trigger('keydown', { key: ' ' })
    expect(w.emitted('open')).toBeUndefined()
  })
})
