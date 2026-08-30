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

  it('rehidrata los tipos de evento de la regla', () => {
    expect(
      mountModal()
        .findAll('.cb-chip__text')
        .map((e) => e.text()),
    ).toContain('issue.scanned')
  })
})
