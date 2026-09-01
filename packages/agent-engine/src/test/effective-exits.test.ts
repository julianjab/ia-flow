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

  // El bug: reemplazar la entrada entera. El editor de reglas sólo produce la
  // forma corta, así que un agente con `{set, when, comment}` perdía las dos
  // cosas que SON suyas — la descripción que el modelo lee para elegir la
  // salida, y dónde queda registrado el hallazgo.
  it('redirigir conserva el `when` del agente', () => {
    const out = resolveEffectiveExits(agentExits, { 'back-to-build': 'Implementación' })
    expect(out?.['back-to-build']).toEqual({
      set: 'Implementación',
      when: 'cuando el diff falla',
    })
    expect(selectableExits(out)).toEqual([{ name: 'back-to-build', when: 'cuando el diff falla' }])
  })

  it('redirigir conserva el `comment` del agente', () => {
    const exits = { 'to-refine': { set: 'Refine', comment: 'issue' as const } }
    const out = resolveEffectiveExits(exits, { 'to-refine': 'Refinamiento' })
    expect(out?.['to-refine']).toEqual({ set: 'Refinamiento', comment: 'issue' })
  })

  // `when` y `comment` son del agente: el primero es lo que el modelo lee en el
  // enum, el segundo dónde vive el hallazgo. La regla sólo cambia el destino.
  it('ignora un `when`/`comment` que venga en el override', () => {
    const out = resolveEffectiveExits(agentExits, {
      'back-to-build': { set: 'Implementación', when: 'otro criterio' },
    })
    expect(out?.['back-to-build']).toEqual({
      set: 'Implementación',
      when: 'cuando el diff falla',
    })
  })

  // Un `set` vacío movería el issue a ningún lado. Dejar la salida como está es
  // lo correcto — es lo mismo que no haber declarado el override.
  it('un override sin destino deja la salida intacta', () => {
    const out = resolveEffectiveExits(agentExits, { success: '' })
    expect(out?.success).toBe('Review')
  })

  it('redirigir una salida en forma corta la deja en forma corta', () => {
    const out = resolveEffectiveExits(agentExits, { success: 'QA Interna' })
    expect(out?.success).toBe('QA Interna')
  })
})
