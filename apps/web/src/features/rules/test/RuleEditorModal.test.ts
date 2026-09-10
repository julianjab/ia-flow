import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RuleEditorModal from '@/features/rules/RuleEditorModal.vue'

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
   * Regresión: el conector AND/OR vivía en un array paralelo a las filas
   * (`logics[i]`) mientras `serializeWhen` filtraba primero las filas sin
   * campo y recién después indexaba con el índice YA filtrado. Vaciar el campo
   * de una condición del MEDIO corría los conectores una posición: la tercera
   * condición se guardaba con el `or` que era de la segunda. Ahora `logic`
   * viaja dentro de la fila y ningún filtro lo puede desalinear.
   */
  it('preserva el conector de cada condición al vaciar una fila del medio', async () => {
    const w = mount(RuleEditorModal, {
      props: {
        rule: {
          id: 'r1',
          on: ['issue.scanned'],
          projectId: null,
          repoName: null,
          enabled: true,
          exclusive: false,
          when: [
            { field: 'status', op: '=', value: 'refine' },
            { field: 'type', op: '=', value: 'bug', logic: 'or' },
            { field: 'labels', op: '=', value: 'epic', logic: 'and' },
          ],
          do: [{ action: 'agent', agentId: 'refiner' }],
        },
        availableKinds: ['agent'],
        agentIds: ['refiner'],
      },
    })

    // Sin ancho para el rail las cuatro franjas se dibujan en orden, así que
    // el editor de condiciones ya está en pantalla.
    const campos = w.findAll('.cre-cell--field input')
    expect(campos).toHaveLength(3)
    await campos[1].setValue('')

    await w.get('button.btn--primary').trigger('click')
    expect(w.emitted('save')?.at(-1)?.[0]).toMatchObject({
      when: [
        { field: 'status', op: '=', value: 'refine' },
        // Con el array paralelo, acá se guardaba `logic: 'or'` — el de la
        // condición que se acaba de vaciar.
        { field: 'labels', op: '=', value: 'epic', logic: 'and' },
      ],
    })
  })

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
   * Bajo --bp-split no hay rail: las cuatro franjas se dibujan en orden y la
   * última, la que se puede ignorar, va plegada. Antes de esto el rail se
   * volvía una tira horizontal de pestañas con scroll lateral (R2, R14).
   */
  it('sin ancho para el rail dibuja las franjas en orden', () => {
    const w = mountModal()

    expect(w.find('.rail-item').exists()).toBe(false)
    // Las tres visibles llevan su título; la cuarta es el encabezado plegado.
    expect(w.findAll('.band-title').map((t) => t.text())).toEqual(['Qué hace', 'Sobre qué'])
    // La franja plegada es hija directa del formulario; el otro
    // `CollapsibleSection` de la pantalla es el de cada acción, más adentro.
    expect(w.get('.page-main > .cs .cs-title').text()).toBe('Avanzado')
  })

  /**
   * El estado dejó de ser un campo perdido entre los de «Avanzado»: se lee en
   * el badge de la cabecera —igual que en la fila del listado— y se cambia en
   * la franja de identidad, en un solo lugar (R17).
   */
  it('el estado se lee en la cabecera y se cambia en Definición', async () => {
    const w = mountModal()
    expect(w.get('.state-badge').text()).toBe('activa')

    await w.get('.tsw').trigger('click')

    expect(w.get('.state-badge').text()).toBe('deshabilitada')
    expect(w.get('.state-badge').classes()).toContain('state-badge--off')
  })

  it('rehidrata los tipos de evento de la regla', () => {
    expect(
      mountModal()
        .findAll('.cb-chip__text')
        .map((e) => e.text()),
    ).toContain('issue.scanned')
  })
})
