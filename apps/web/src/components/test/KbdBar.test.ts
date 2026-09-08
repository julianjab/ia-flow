import KbdBar from '@/components/KbdBar.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

async function mountAt(mobile: boolean, props: Record<string, unknown> = {}) {
  vi.resetModules()
  vi.doMock('@/composables/useIsMobile', () => ({
    useIsMobile: () => ({ isMobile: ref(mobile) }),
  }))
  const Cmp = (await import('@/components/KbdBar.vue')).default
  return mount(Cmp, { props })
}

describe('KbdBar', () => {
  it('anuncia SÓLO los atajos que existen', () => {
    // `useKeyboardNav` bindea j/k, flechas, Enter y Escape. Una barra que
    // ofreciera `r reintentar` enseñaría un gesto que falla en silencio.
    const w = mount(KbdBar)
    const text = w.text()
    expect(text).toContain('j/k')
    expect(text).toContain('⏎')
    expect(text).toContain('esc')
    expect(text).not.toContain('r ')
  })

  it('bajo --bp-shell no se renderiza — no hay teclado que anunciar', async () => {
    // `v-if` y no `display: none` (T10): un nodo escondido igual ocupa el DOM y
    // lo lee un lector de pantalla.
    const w = await mountAt(true)
    expect(w.find('.kbdbar').exists()).toBe(false)
    vi.doUnmock('@/composables/useIsMobile')
  })

  it('sin `action` no dibuja el link de escape', () => {
    expect(mount(KbdBar).find('.kbdbar__action').exists()).toBe(false)
  })

  it('con `action`, emite al tocarlo', async () => {
    const w = mount(KbdBar, { props: { action: { label: 'ver las 42 tareas' } } })
    await w.get('.kbdbar__action').trigger('click')
    expect(w.emitted('action')).toHaveLength(1)
  })
})
