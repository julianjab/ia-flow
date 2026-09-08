import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// Bajo --bp-shell el desplegable es un bottom sheet y no un popover anclado
// (T11, R6). No es estética: un popover anclado a un input queda fuera de la
// pantalla en cuanto sube el teclado virtual — el campo está a media altura, el
// teclado se come el 45% de abajo, y la lista se dibuja justamente ahí.

const OPTIONS = [{ value: 'main' }, { value: 'develop' }]

afterEach(() => {
  document.body.style.overflow = ''
  vi.resetModules()
  vi.doUnmock('@/composables/useIsMobile')
})

async function mountAt(mobile: boolean) {
  vi.resetModules()
  // `ref` y no `{ value }`: Vue desenvuelve refs en el template, y un objeto
  // plano llega como objeto — o sea, siempre truthy. Con `{ value: false }` el
  // componente creía estar en mobile y el test pasaba por la razón equivocada.
  vi.doMock('@/composables/useIsMobile', () => ({
    useIsMobile: () => ({ isMobile: ref(mobile) }),
  }))
  const Cmp = (await import('@/ui/ComboBox.vue')).default
  return mount(Cmp, {
    props: { modelValue: '', options: OPTIONS, placeholder: 'Rama' },
    attachTo: document.body,
  })
}

describe('ComboBox — el desplegable a cada lado del breakpoint', () => {
  it('sobre --bp-shell abre el popover anclado, no un sheet', async () => {
    const w = await mountAt(false)
    await w.get('.cb-box').trigger('click')
    expect(w.find('.cb-list').exists()).toBe(true)
    expect(document.querySelector('.bs')).toBeNull()
    w.unmount()
  })

  it('bajo --bp-shell abre el sheet y NO el popover', async () => {
    const w = await mountAt(true)
    await w.get('.cb-box').trigger('click')
    expect(w.find('.cb-list').exists()).toBe(false)
    expect(document.querySelector('.bs')).not.toBeNull()
    // Las opciones son las mismas: lo que cambia es el contenedor, no el
    // contenido — dos vocabularios de opción serían dos cosas que mantener.
    expect(document.querySelectorAll('.cb-sheet-list .cb-opt').length).toBe(2)
    w.unmount()
  })

  it('el sheet trae su propia búsqueda arriba', async () => {
    // Donde el pulgar no la tapa y el teclado no la empuja.
    const w = await mountAt(true)
    await w.get('.cb-box').trigger('click')
    expect(document.querySelector('.cb-sheet-input')).not.toBeNull()
    w.unmount()
  })

  it('elegir en el sheet emite el valor', async () => {
    const w = await mountAt(true)
    await w.get('.cb-box').trigger('click')
    const first = document.querySelector('.cb-sheet-list .cb-opt') as HTMLElement
    first.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['main'])
    w.unmount()
  })

  it('ComboBox sin usar no monta ningún sheet', async () => {
    const w = await mountAt(true)
    expect(document.querySelector('.bs')).toBeNull()
    w.unmount()
  })
})
