import RuleEditorModal from '@/features/rules/RuleEditorModal.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

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

describe('RuleEditorModal', () => {
  /**
   * Un `<label>` reenvía el click de cualquier descendiente a su PRIMER
   * control, y en un campo de chips ése es la ✕ del primer chip: elegir un
   * segundo tipo de evento agregaba el nuevo y borraba el que ya estaba, con
   * las dos emisiones en el mismo tick.
   *
   * Se chequea la ESTRUCTURA y no el click porque happy-dom no implementa el
   * reenvío del label: un test de comportamiento pasaría con el bug puesto.
   */
  it('los campos de chips no viven dentro de un <label>', () => {
    const w = mountModal()
    const dentroDeLabel = w.findAll('.cb').filter((cb) => cb.element.closest('label') !== null)
    expect(dentroDeLabel).toHaveLength(0)
  })

  /**
   * El editor pasó de ser un diálogo con todo apilado a la página de secciones
   * del editor de agentes: el rail es la única forma de llegar a "Qué hace" y
   * a "Avanzado", así que si deja de marcar la sección elegida esas dos
   * quedan inalcanzables.
   */
  it('el rail cambia la sección activa', async () => {
    const w = mountModal()
    const items = w.findAll('.rail-item')
    expect(items).toHaveLength(4)
    expect(items[0].classes()).toContain('rail-item--active')

    await items[2].trigger('click')
    expect(w.findAll('.rail-item')[2].classes()).toContain('rail-item--active')
    expect(w.findAll('.rail-item')[0].classes()).not.toContain('rail-item--active')
  })

  /**
   * El resumen se arma con el formulario, no con la regla guardada: es lo que
   * permite verificar lo que uno acaba de escribir sin guardar y volver a
   * abrir.
   */
  it('el resumen refleja lo editado, no lo guardado', async () => {
    const w = mountModal()
    // La frase sale de la regla, igual que en el listado.
    expect(w.get('.summary-card').text()).toContain('refiner')
    expect(w.get('.summary-card').text()).toContain('Habilitada')

    // Y se actualiza con el formulario, sin pasar por guardar.
    await w.findAll('.rail-item')[3].trigger('click')
    await w.findAll('.check input[type="checkbox"]')[0].setValue(false)
    expect(w.get('.summary-card').text()).toContain('no va a correr')
  })

  it('rehidrata los tipos de evento de la regla', () => {
    expect(
      mountModal()
        .findAll('.cb-chip__text')
        .map((e) => e.text()),
    ).toContain('issue.scanned')
  })
})
