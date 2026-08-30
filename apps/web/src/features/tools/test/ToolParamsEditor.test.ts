import ToolParamsEditor from '@/features/tools/ToolParamsEditor.vue'
import type { NamedActionBody, ToolParam } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

// El input del modelo viaja como `event.payload` y la acción lo lee con
// `{{event.payload.<campo>}}`. Los dos lados NO son independientes, y lo que se
// testea acá es justamente que el editor lo diga.

const HTTP: NamedActionBody = {
  action: 'http',
  url: 'https://ci/deploy/{{event.payload.branch}}',
  method: 'POST',
  body: { env: '{{event.payload.target}}' },
}

function mountEditor(modelValue: ToolParam[], actionBody: NamedActionBody | null = HTTP) {
  return mount(ToolParamsEditor, { props: { modelValue, actionBody } })
}

describe('ToolParamsEditor', () => {
  // Un campo que la acción lee y la tool no declara se interpola como string
  // vacío — en silencio, del otro lado. Ofrecerlo de un click es la forma más
  // corta de que los dos lados coincidan.
  it('ofrece los campos que la acción lee y la tool no declara', () => {
    const w = mountEditor([])
    const chips = w.findAll('.tp-add').map((b) => b.text())
    expect(chips).toEqual(['+ branch', '+ target'])
  })

  it('agregar un campo sugerido lo emite con su nombre', async () => {
    const w = mountEditor([])
    await w.findAll('.tp-add')[0].trigger('click')

    expect(w.emitted('update:modelValue')?.[0][0]).toEqual([{ name: 'branch', type: 'string' }])
  })

  it('lo declarado no se vuelve a ofrecer', () => {
    const w = mountEditor([{ name: 'branch', type: 'string' }])
    expect(w.findAll('.tp-add').map((b) => b.text())).toEqual(['+ target'])
  })

  // El otro lado del mismo desajuste: un parámetro que la acción no lee es un
  // dato que el modelo completa para nada.
  it('marca un parámetro que la acción no lee', () => {
    const w = mountEditor([{ name: 'sobra', type: 'string' }])
    expect(w.find('.tp-unread').text()).toContain('la acción no lo lee')
  })

  // Sin acción elegida todavía no hay contra qué contrastar: marcar todo como
  // "no leído" sería ruido, no información.
  it('sin acción no marca nada', () => {
    const w = mountEditor([{ name: 'x', type: 'string' }], null)
    expect(w.find('.tp-unread').exists()).toBe(false)
    expect(w.findAll('.tp-add')).toHaveLength(0)
  })

  // `emit-action.ts` publica su payload declarado TAL CUAL y `agent-action.ts`
  // sólo mira `payload.item`: sobre esas dos, unos parámetros prolijos no
  // llegan a ningún lado. Es el peor caso de la feature, así que se dice.
  it('avisa cuando la acción no interpola el input', () => {
    const w = mountEditor([{ name: 'x', type: 'string' }], { action: 'emit', type: 'algo.paso' })
    expect(w.find('.tp-warn').text()).toContain('no interpola el input')
    // Y no marca "no lo lee" encima: el problema es la acción, no el parámetro.
    expect(w.find('.tp-unread').exists()).toBe(false)
  })

  it('quitar un parámetro lo saca de la lista emitida', async () => {
    const w = mountEditor([
      { name: 'branch', type: 'string' },
      { name: 'target', type: 'string' },
    ])
    await w.findAll('.tp-x')[0].trigger('click')

    expect(w.emitted('update:modelValue')?.[0][0]).toEqual([{ name: 'target', type: 'string' }])
  })

  // Lo que no se frena acá llega a la API del modelo: `properties: { '': ... }`
  // hace que rechace el request entero y se caiga el run del agente.
  it('marca un parámetro sin nombre y dice por qué no se puede guardar', () => {
    const w = mountEditor([{ name: '', type: 'string' }])

    expect(w.find('.tp-name').classes()).toContain('tp-bad')
    expect(w.find('.tp-error').text()).toContain('sin nombre')
  })

  it('marca los dos lados de un nombre repetido', () => {
    const w = mountEditor([
      { name: 'branch', type: 'string' },
      { name: 'branch', type: 'number' },
    ])

    expect(w.findAll('.tp-name').filter((i) => i.classes().includes('tp-bad'))).toHaveLength(2)
    expect(w.find('.tp-error').text()).toContain('repetido')
  })
})
