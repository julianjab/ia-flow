import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import RepoConfigModal from '@/features/repos/RepoConfigModal.vue'

/**
 * Un smoke test de montaje, y no es trivial: este componente estuvo **roto** —
 * un `</div>` cerrando un `<label>`, la pantalla no cargaba— y `vue-tsc`,
 * biome y los tests pasaron en verde porque nadie lo montaba. El único que lo
 * dijo fue abrir la app.
 *
 * Montar el componente es lo que convierte "compila" en "carga".
 */
// Sin esto el montaje sale a la red de verdad y el test depende del daemon.
vi.mock('@/features/repos/api', () => ({
  getLocalRepos: vi.fn(async () => []),
}))
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: vi.fn(), error: vi.fn() }),
}))

function mountModal(props: Record<string, unknown> = {}) {
  return mount(RepoConfigModal, {
    props: { open: true, editingName: null, repos: [], ...props },
    global: { stubs: { Teleport: true, RepoDescriptionField: true, SlackReviewFields: true } },
    attachTo: document.body,
  })
}

describe('RepoConfigModal', () => {
  it('monta y dibuja sus campos', () => {
    const w = mountModal()
    expect(document.querySelector('.fs__title')?.textContent).toContain('repo')
    // Los campos son del kit, no de una copia con prefijo propio.
    expect(document.querySelectorAll('.ff-row').length).toBeGreaterThan(3)
    w.unmount()
  })

  it('el pie ofrece cancelar y guardar', () => {
    const w = mountModal()
    const foot = document.querySelector('.fs__foot')
    expect(foot?.textContent).toContain('Cancelar')
    expect(foot?.textContent).toContain('Guardar')
    w.unmount()
  })

  it('cerrado no monta nada', () => {
    const w = mountModal({ open: false })
    expect(document.querySelector('.fs')).toBeNull()
    w.unmount()
  })
})
