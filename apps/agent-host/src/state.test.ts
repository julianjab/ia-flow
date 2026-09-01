import { describe, expect, it } from 'bun:test'
import type { AdmissionRule } from './admission.js'
import { defaultState, sanitizeState } from './state.js'

const RULES: AdmissionRule[] = [{ field: 'repo', op: 'equals', value: 'lh-seller-v2-frontend' }]

describe('defaultState — arranque en frío', () => {
  it('sin config, sin reglas: el agent-host admite lo que le manden', () => {
    expect(defaultState().admissionRules).toEqual([])
  })

  it('las reglas del agent-host.yaml son el arranque en frío', () => {
    // El caso que esto arregla: un pod que bootea con el volumen vacío y
    // nadie que abra la pantalla. Antes arrancaba admitiendo TODO.
    expect(defaultState({ admission: { rules: RULES } }).admissionRules).toEqual(RULES)
  })

  it('una regla mal formada del YAML se descarta, no se propaga', () => {
    const cfg = { admission: { rules: [{ field: 'nope', op: 'equals', value: 'x' }] } }
    expect(defaultState(cfg as never).admissionRules).toEqual([])
  })
})

describe('sanitizeState — qué gana entre la pantalla y el arranque en frío', () => {
  const cold = defaultState({ admission: { rules: RULES } })

  it('un estado guardado SIN la clave conserva las reglas declaradas', () => {
    // La regresión: cualquier guardado desde la pantalla (cambiar el provider,
    // el cap, el workspace) escribe un JSON sin `admissionRules` si el estado
    // en memoria no las tenía, y el siguiente restart arrancaba sin reglas.
    expect(sanitizeState({ providerId: 'anthropic-api' }, cold).admissionRules).toEqual(RULES)
  })

  it('un estado guardado CON reglas gana sobre el YAML', () => {
    // Anotado: sin el tipo, TS infiere `field: string` y `op: string`, que no
    // son asignables a las uniones de literales de `AdmissionRule` — y el
    // `toEqual` de abajo no compila.
    const saved: { admissionRules: AdmissionRule[] } = {
      admissionRules: [{ field: 'agentId', op: 'equals', value: 'e2e' }],
    }
    expect(sanitizeState(saved, cold).admissionRules).toEqual(saved.admissionRules)
  })

  it('una lista vacía guardada a propósito se respeta — es "sin reglas", no "sin dato"', () => {
    expect(sanitizeState({ admissionRules: [] }, cold).admissionRules).toEqual([])
  })
})
