import FullScreen from '@/ui/FullScreen.vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

afterEach(() => {
  document.body.style.overflow = ''
})

describe('FullScreen', () => {
  it('cerrado no monta nada — un diálogo que nadie va a ver no existe', () => {
    const w = mount(FullScreen, {
      props: { open: false, title: 'Editar repo' },
      attachTo: document.body,
    })
    expect(document.querySelector('.fs')).toBeNull()
    w.unmount()
  })

  it('abierto dibuja el título y el cuerpo', () => {
    const w = mount(FullScreen, {
      props: { open: true, title: 'Editar repo' },
      slots: { default: '<p class="body">campo</p>' },
      attachTo: document.body,
    })
    expect(document.querySelector('.fs__title')?.textContent).toBe('Editar repo')
    expect(document.querySelector('.body')).not.toBeNull()
    w.unmount()
  })

  it('el pie sólo existe si alguien lo llena — una barra vacía come alto', () => {
    const sin = mount(FullScreen, {
      props: { open: true, title: 'x' },
      attachTo: document.body,
    })
    expect(document.querySelector('.fs__foot')).toBeNull()
    sin.unmount()

    const con = mount(FullScreen, {
      props: { open: true, title: 'x' },
      slots: { footer: '<button class="btn">Guardar</button>' },
      attachTo: document.body,
    })
    expect(document.querySelector('.fs__foot')).not.toBeNull()
    con.unmount()
  })

  it('el fondo no scrollea mientras está abierto', () => {
    // Sin el bloqueo, el gesto de scrollear dentro del detalle arrastra la
    // página de atrás en cuanto llega a su tope, y se pierde el lugar.
    const w = mount(FullScreen, { props: { open: true, title: 'x' }, attachTo: document.body })
    expect(document.body.style.overflow).toBe('hidden')
    w.unmount()
  })

  it('Escape cierra', async () => {
    const w = mount(FullScreen, { props: { open: true, title: 'x' }, attachTo: document.body })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('`closeOnBackdrop: false` protege un formulario con cambios sin guardar', async () => {
    // Perder lo escrito por un toque al costado es el peor default posible.
    const w = mount(FullScreen, {
      props: { open: true, title: 'x', closeOnBackdrop: false },
      attachTo: document.body,
    })
    const backdrop = document.querySelector('.fs-backdrop') as HTMLElement
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(w.emitted('close')).toBeUndefined()
    w.unmount()
  })
})
