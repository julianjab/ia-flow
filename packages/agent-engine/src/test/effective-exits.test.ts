import { describe, expect, it } from 'bun:test'
import { resolveEffectiveExits, selectableExits } from '../run-outcome.js'

// La invariante que este override tiene que preservar: el AGENTE es dueño de
// qué salidas existen (es lo que va al enum de `select_exit`); la REGLA, de a
// dónde va cada una.

const agentExits = {
  success: 'Review',
  error: '$set:Labels=+blocked',
  'back-to-build': { set: 'Build', when: 'cuando el diff falla' },
}

describe('resolveEffectiveExits', () => {
  it('sin override devuelve las del agente, tal cual', () => {
    expect(resolveEffectiveExits(agentExits, undefined)).toBe(agentExits)
    expect(resolveEffectiveExits(agentExits, {})).toBe(agentExits)
  })

  // El caso que lo motivó: el mismo roster contra otro board, donde la columna
  // no se llama igual. Hoy eso obliga a clonar el agente entero.
  it('redirige el destino de una salida sin tocar las demás', () => {
    const out = resolveEffectiveExits(agentExits, { success: 'QA Interna' })
    expect(out?.success).toBe('QA Interna')
    expect(out?.error).toBe('$set:Labels=+blocked')
    expect(out?.['back-to-build']).toEqual({ set: 'Build', when: 'cuando el diff falla' })
  })

  it('no muta el objeto del agente', () => {
    resolveEffectiveExits(agentExits, { success: 'QA Interna' })
    expect(agentExits.success).toBe('Review')
  })

  // Una salida que existiera para `resolveExit` pero no en el enum de
  // `select_exit` sería inalcanzable a propósito e indiagnosticable cuando
  // pasa. Por eso se descarta en vez de agregarse.
  it('descarta una clave que el agente no declara', () => {
    const out = resolveEffectiveExits(agentExits, { 'no-existe': 'Otra' })
    expect(out?.['no-existe']).toBeUndefined()
    expect(Object.keys(out ?? {}).sort()).toEqual(['back-to-build', 'error', 'success'])
  })

  it('aplica las conocidas aunque vengan mezcladas con una desconocida', () => {
    const out = resolveEffectiveExits(agentExits, { success: 'QA', inventada: 'X' })
    expect(out?.success).toBe('QA')
    expect(out?.inventada).toBeUndefined()
  })

  it('un agente sin exits no gana salidas por el override', () => {
    expect(resolveEffectiveExits(undefined, { success: 'QA' })).toBeUndefined()
  })

  // La regla puede redirigir success/error aunque no sean elegibles: los elige
  // el engine por cómo terminó el run, no el modelo.
  it('el override no cambia qué salidas puede PEDIR el agente', () => {
    const out = resolveEffectiveExits(agentExits, { success: 'QA Interna' })
    expect(selectableExits(out).map((e) => e.name)).toEqual(['back-to-build'])
  })

  // Redirigir el destino no puede borrar la descripción que el modelo lee para
  // decidir: si el override viene en forma corta, el `when` se pierde.
  it('un override en forma larga conserva su propio when', () => {
    const out = resolveEffectiveExits(agentExits, {
      'back-to-build': { set: 'Implementación', when: 'otro criterio' },
    })
    expect(selectableExits(out)).toEqual([{ name: 'back-to-build', when: 'otro criterio' }])
  })
})
