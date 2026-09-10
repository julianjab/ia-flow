import { mount } from '@vue/test-utils'
import { beforeAll, describe, expect, it } from 'vitest'
import RuleEditorModal from '@/features/rules/RuleEditorModal.vue'

// El editor sobre --bp-split, donde el índice es el rail al costado y se ve
// una franja por vez. Va en su propio archivo porque `useIsMobile` cachea el
// `MediaQueryList` por query para toda la app: stubear `matchMedia` a mitad de
// un archivo no cambiaría el valor que el primer `mount` ya resolvió.
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 1100px'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

const mountModal = () =>
  mount(RuleEditorModal, {
    props: {
      rule: {
        id: 'r1',
        on: ['issue.scanned'],
        projectId: null,
        repoName: null,
        enabled: true,
        exclusive: false,
        do: [{ action: 'agent', agentId: 'refiner' }],
      },
      availableKinds: ['agent', 'emit', 'http'],
      agentIds: ['refiner'],
    },
  })

describe('RuleEditorModal · sobre --bp-split', () => {
  /**
   * El rail es la única forma de llegar a las franjas que no son la primera,
   * así que si deja de marcar la elegida las otras tres quedan inalcanzables.
   */
  it('el rail cambia la franja activa', async () => {
    const w = mountModal()
    const items = w.findAll('.rail-item')
    expect(items).toHaveLength(4)
    expect(items[0].classes()).toContain('rail-item--active')

    await items[2].trigger('click')
    expect(w.findAll('.rail-item')[2].classes()).toContain('rail-item--active')
    expect(w.findAll('.rail-item')[0].classes()).not.toContain('rail-item--active')
  })

  /**
   * R19: el orden de las franjas es fijo, y para una regla «qué hace» es el
   * evento MÁS las acciones. Antes las acciones iban después del ámbito, así
   * que el formulario contaba primero las excepciones y al final la regla.
   */
  it('lista las franjas en el orden del sistema', () => {
    expect(
      mountModal()
        .findAll('.rail-title')
        .map((t) => t.text()),
    ).toEqual(['Definición', 'Qué hace', 'Sobre qué', 'Avanzado'])
  })

  /**
   * El resumen se arma con el formulario, no con la regla guardada: es lo que
   * permite verificar lo que uno acaba de escribir sin guardar y volver a
   * abrir.
   */
  it('el resumen refleja lo editado, no lo guardado', async () => {
    const w = mountModal()
    expect(w.get('.summary-card').text()).toContain('refiner')
    expect(w.get('.summary-card').text()).toContain('Habilitada')

    // El interruptor vive en Definición, que es la franja activa al abrir.
    await w.get('.tsw').trigger('click')
    expect(w.get('.summary-card').text()).toContain('no va a correr')
  })
})
