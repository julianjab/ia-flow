import RuleSentence from '@/features/rules/RuleSentence.vue'
import type { Rule } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

const rule = (over: Partial<Rule> = {}): Rule =>
  ({ id: 'r1', on: ['pr.opened'], do: [], ...over }) as Rule

const seg = (w: ReturnType<typeof mount>, cls: string) => w.findAll(`.${cls}`).map((e) => e.text())

describe('RuleSentence', () => {
  it('escribe la regla como una frase: evento → acción', () => {
    const w = mount(RuleSentence, {
      props: { rule: rule({ do: [{ action: 'agent', agentId: 'reviewer' }] as Rule['do'] }) },
    })

    expect(seg(w, 'rs-event')).toEqual(['pr.opened'])
    expect(seg(w, 'rs-agent')).toEqual(['reviewer'])
    expect(w.text()).toContain('Cuando')
  })

  // El status es una condición más desde la migración 059, pero sigue siendo la
  // que el operador busca primero ("¿qué corre en Construir?"), así que se
  // extrae de las condiciones y se muestra como su propio segmento.
  it('saca el status de las condiciones y lo muestra aparte', () => {
    const w = mount(RuleSentence, {
      props: {
        rule: rule({
          when: [
            { field: 'status', op: '=', value: 'Construir' },
            { field: 'additions', op: '>', value: '500' },
          ] as Rule['when'],
        }),
      },
    })

    expect(seg(w, 'rs-status')).toEqual(['Construir'])
    // Y no se repite entre las condiciones comunes.
    expect(seg(w, 'rs-cond')).toEqual(['additions > 500'])
  })

  it('varios tipos de evento se listan todos', () => {
    const w = mount(RuleSentence, {
      props: { rule: rule({ on: ['pr.opened', 'pr.synchronize'] }) },
    })
    expect(seg(w, 'rs-event')).toEqual(['pr.opened', 'pr.synchronize'])
  })

  it('cada tipo de acción se lee como lo suyo', () => {
    const w = mount(RuleSentence, {
      props: {
        rule: rule({
          do: [
            { action: 'http', method: 'POST', url: 'https://x/y' },
            { action: 'emit', type: 'intake.classified' },
          ] as Rule['do'],
        }),
      },
    })

    expect(w.text()).toContain('POST https://x/y')
    expect(w.text()).toContain('intake.classified')
  })

  // Una regla sin acciones no hace nada, y es un error silencioso: nada falla,
  // simplemente no pasa nada. La frase lo dice.
  it('una regla sin acciones lo dice en la frase', () => {
    const w = mount(RuleSentence, { props: { rule: rule({ do: [] }) } })
    expect(w.find('.rs-empty').text()).toBe('sin acciones')
  })

  it('los operadores de presencia se leen en palabras', () => {
    const w = mount(RuleSentence, {
      props: { rule: rule({ when: [{ field: 'prNumber', op: '$not_null' }] as Rule['when'] }) },
    })
    expect(seg(w, 'rs-cond')).toEqual(['prNumber presente'])
  })

  // Una ref y una acción inline se leen igual sin esto, y nadie sabe que al
  // tocarla edita algo definido en otro lado que además usan otras reglas.
  it('marca la referencia con ↗ para distinguirla de una acción inline', () => {
    const w = mount(RuleSentence, {
      props: { rule: rule({ do: [{ action: 'ref', actionId: 'avisar-deploy' }] as Rule['do'] }) },
    })

    expect(seg(w, 'rs-ref')).toEqual(['↗ avisar-deploy'])
  })

  it('una ref y una inline conviven en la misma frase', () => {
    const w = mount(RuleSentence, {
      props: {
        rule: rule({
          do: [
            { action: 'ref', actionId: 'avisar' },
            { action: 'agent', agentId: 'releaser' },
          ] as Rule['do'],
        }),
      },
    })

    expect(seg(w, 'rs-ref')).toEqual(['↗ avisar'])
    expect(seg(w, 'rs-agent')).toEqual(['releaser'])
  })
})
