import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import ListControlsBar from '../ListControlsBar.vue'

// `useIsMobile` lee `matchMedia`. En jsdom no existe, así que el composable cae
// a `false` (desktop). Para el camino táctil se stubea el módulo entero: es el
// mismo 768px que el CSS, y lo que se está testeando es qué DIBUJA la barra a
// cada lado del breakpoint, no cómo se detecta.
function mockMobile(value: boolean) {
  // `ref` y no `{ value }`: Vue desenvuelve refs en el template, y un objeto
  // plano llega como objeto — siempre truthy. Con `{ value: false }` el
  // componente creería estar en mobile aunque el test pida desktop.
  vi.doMock('@/composables/useIsMobile', () => ({
    useIsMobile: () => ({ isMobile: ref(value) }),
  }))
}

describe('ListControlsBar', () => {
  it('sobre --bp-shell el panel de filtros está inline y no hay `filtros ⌄`', () => {
    const w = mount(ListControlsBar, {
      props: { filterCount: 2, summary: 'todo +1' },
      slots: { view: '<b>Lista</b>', default: '<input data-testid="q" />' },
      global: { stubs: { BottomSheet: true } },
    })
    // El input de filtros ES el flujo de la pantalla en escritorio: esconderlo
    // tras un clic cambia un problema de mobile por uno de desktop.
    expect(w.find('[data-testid="q"]').exists()).toBe(true)
    expect(w.find('[data-testid="list-controls-filters"]').exists()).toBe(false)
    // Y el resumen no se dibuja: los tokens del input ya dicen qué está puesto.
    expect(w.find('[data-testid="list-controls-active"]').exists()).toBe(false)
  })

  it('siempre dibuja el slot de vista', () => {
    const w = mount(ListControlsBar, {
      slots: { view: '<b class="v">Lista</b>' },
      global: { stubs: { BottomSheet: true } },
    })
    expect(w.find('.v').exists()).toBe(true)
  })

  it('sin slot de filtros no ofrece `filtros ⌄` — abriría un sheet vacío', () => {
    const w = mount(ListControlsBar, {
      slots: { view: '<b>Board</b>' },
      global: { stubs: { BottomSheet: true } },
    })
    expect(w.find('[data-testid="list-controls-filters"]').exists()).toBe(false)
    expect(w.find('.lcb__panel').exists()).toBe(false)
  })

  it('los controles de forma van en la fila cuando hay ancho', () => {
    const w = mount(ListControlsBar, {
      slots: { view: '<b>Lista</b>', tools: '<button class="t">por fecha</button>' },
      global: { stubs: { BottomSheet: true } },
    })
    expect(w.get('.lcb__row .t').exists()).toBe(true)
    expect(w.find('.lcb__sheet-tools').exists()).toBe(false)
  })

  it('bajo --bp-shell bajan al sheet: seis controles no entran en 390px (R2)', async () => {
    // Es el bug que arreglaron: Tareas metía vista + contador + orden +
    // actualizar + filtro activo + `filtros ⌄` en una fila, y la pantalla
    // terminaba con 199px de scroll horizontal.
    vi.resetModules()
    mockMobile(true)
    const Mobile = (await import('../ListControlsBar.vue')).default
    const w = mount(Mobile, {
      props: { filterCount: 1, summary: 'me toca 4' },
      slots: {
        view: '<b>Lista</b>',
        tools: '<button class="t">por fecha</button>',
        default: '<input data-testid="q" />',
      },
      global: { stubs: { BottomSheet: { template: '<div><slot /></div>' } } },
    })
    expect(w.find('.lcb__row .t').exists()).toBe(false)
    expect(w.get('.lcb__sheet-tools .t').exists()).toBe(true)
    vi.doUnmock('@/composables/useIsMobile')
  })

  it('bajo --bp-shell el filtro activo y `filtros ⌄` reemplazan al panel inline', async () => {
    vi.resetModules()
    mockMobile(true)
    const Mobile = (await import('../ListControlsBar.vue')).default
    const w = mount(Mobile, {
      props: { filterCount: 3, summary: 'me toca 4' },
      slots: { view: '<b>Lista</b>', default: '<input data-testid="q" />' },
      global: { stubs: { BottomSheet: { template: '<div><slot /></div>' } } },
    })
    expect(w.get('[data-testid="list-controls-active"]').text()).toBe('me toca 4')
    expect(w.get('[data-testid="list-controls-filters"]').text()).toContain('3')
    expect(w.find('.lcb__panel').exists()).toBe(false)
    vi.doUnmock('@/composables/useIsMobile')
  })
})
