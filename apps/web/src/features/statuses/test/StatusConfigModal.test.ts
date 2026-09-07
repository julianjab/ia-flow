import StatusConfigModal from '@/features/statuses/StatusConfigModal.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

// Smoke de montaje: este componente se migró a `FullScreen` y al kit de campo
// con reemplazos de texto, y no había nada que lo montara. Un `.vue` puede
// compilar y no cargar — ver RepoConfigModal.test.ts.

function mountModal(props: Record<string, unknown> = {}) {
  return mount(StatusConfigModal, {
    props: { open: true, statusConfig: null, ...props },
    global: { stubs: { Teleport: true } },
    attachTo: document.body,
  })
}

describe('StatusConfigModal', () => {
  it('monta y dibuja el campo de nombre', () => {
    const w = mountModal()
    expect(document.querySelector('.ff-row')).not.toBeNull()
    expect(document.querySelector('.fs__title')).not.toBeNull()
    w.unmount()
  })

  it('con statuses de la fuente ofrece un select, no un input libre', () => {
    // El nombre lo define la fuente: escribirlo a mano inventa un status que
    // el board no tiene.
    const w = mountModal({ statusOptions: ['todo', 'doing'] })
    expect(document.querySelector('select.ff-field')).not.toBeNull()
    w.unmount()
  })

  it('sin statuses cae a input libre', () => {
    const w = mountModal()
    expect(document.querySelector('input.ff-field')).not.toBeNull()
    w.unmount()
  })

  it('`deletable` es opt-in: sin él no se ofrece borrar', () => {
    const sin = mountModal()
    expect(document.querySelector('.fs__foot')?.textContent).not.toContain('Eliminar')
    sin.unmount()
    const con = mountModal({ deletable: true })
    expect(document.querySelector('.fs__foot')?.textContent).toContain('Eliminar')
    con.unmount()
  })
})
