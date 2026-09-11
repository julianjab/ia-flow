import { describe, expect, it } from 'bun:test'
import type { SystemPromptBlock } from '@ia-flow/shared'
import type { AdmissionRule } from './admission.js'
import { defaultState, sanitizeState, sanitizeSystemPrompt } from './state.js'

const RULES: AdmissionRule[] = [{ field: 'repo', op: 'equals', value: 'lh-seller-v2-frontend' }]
const BLOCKS: SystemPromptBlock[] = [{ type: 'text', text: 'Estás en una VM efímera de CI.' }]

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

  it('sin config, sin system prompt propio', () => {
    expect(defaultState().systemPrompt).toEqual([])
  })

  it('el system prompt del agent-host.yaml es el arranque en frío', () => {
    expect(defaultState({ systemPrompt: { blocks: BLOCKS } }).systemPrompt).toEqual(BLOCKS)
  })
})

describe('sanitizeSystemPrompt', () => {
  it('body sin `blocks` array cae al fallback', () => {
    expect(sanitizeSystemPrompt({}, BLOCKS)).toEqual(BLOCKS)
    expect(sanitizeSystemPrompt(null, BLOCKS)).toEqual(BLOCKS)
  })

  it('descarta bloques que no tienen `type: text` + `text: string`', () => {
    expect(
      sanitizeSystemPrompt(
        { blocks: [{ type: 'text', text: 'ok' }, { type: 'image' }, { text: 42 }, 'no-object'] },
        [],
      ),
    ).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('una lista vacía a propósito se respeta', () => {
    expect(sanitizeSystemPrompt({ blocks: [] }, BLOCKS)).toEqual([])
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

  it('un estado guardado SIN la clave conserva el system prompt del YAML', () => {
    const coldWithPrompt = defaultState({ systemPrompt: { blocks: BLOCKS } })
    expect(sanitizeState({ providerId: 'anthropic-api' }, coldWithPrompt).systemPrompt).toEqual(
      BLOCKS,
    )
  })

  it('un system prompt guardado CON bloques gana sobre el YAML', () => {
    // Anotado por el mismo motivo que el `saved` de admissionRules más arriba.
    const saved: { systemPrompt: SystemPromptBlock[] } = {
      systemPrompt: [{ type: 'text', text: 'de la pantalla' }],
    }
    expect(sanitizeState(saved, cold).systemPrompt).toEqual(saved.systemPrompt)
  })

  it('un system prompt vacío guardado a propósito se respeta', () => {
    const coldWithPrompt = defaultState({ systemPrompt: { blocks: BLOCKS } })
    expect(sanitizeState({ systemPrompt: [] }, coldWithPrompt).systemPrompt).toEqual([])
  })
})
