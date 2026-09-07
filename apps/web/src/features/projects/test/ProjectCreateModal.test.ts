import ProjectCreateModal from '@/features/projects/ProjectCreateModal.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

// Smoke de montaje — ver RepoConfigModal.test.ts para el porqué: un `.vue`
// puede compilar, pasar biome y pasar los tests, y no cargar.

vi.mock('@/features/projects/store', () => ({
  useProjectsStore: () => ({ create: vi.fn(), projects: [] }),
}))
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: vi.fn(), error: vi.fn() }),
}))

function mountModal(props: Record<string, unknown> = {}) {
  return mount(ProjectCreateModal, {
    props: { open: true, ...props },
    global: { stubs: { Teleport: true, SourceFormSwitch: true, DaemonModeField: true } },
    attachTo: document.body,
  })
}

describe('ProjectCreateModal', () => {
  it('monta con sus campos del kit', () => {
    const w = mountModal()
    expect(document.querySelectorAll('.ff-row').length).toBeGreaterThanOrEqual(2)
    expect(document.querySelector('.fs__title')?.textContent).toContain('proyecto')
    w.unmount()
  })

  it('no se puede crear sin nombre ni id', () => {
    const w = mountModal()
    const crear = [...document.querySelectorAll('.fs__foot .btn')].find((b) =>
      b.textContent?.includes('Crear'),
    ) as HTMLButtonElement
    expect(crear.disabled).toBe(true)
    w.unmount()
  })

  it('cerrado no monta nada', () => {
    const w = mountModal({ open: false })
    expect(document.querySelector('.fs')).toBeNull()
    w.unmount()
  })
})
