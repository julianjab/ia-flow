import { describe, expect, it } from 'vitest'
import { buildTaskUiContract, findTaskUiOperation } from '../uiContract'

/** Las ramas del `anyOf` de `row-action`, una por operación disponible. */
function branches(statuses: string[]) {
  const primitive = buildTaskUiContract({ statuses }).primitives.find((p) => p.id === 'row-action')
  if (!primitive) throw new Error('el contrato no trae la primitiva row-action')
  return (primitive.props as { anyOf: Record<string, any>[] }).anyOf
}

describe('buildTaskUiContract', () => {
  it('ofrece una operación para cambiar el status cuando el board tiene statuses', () => {
    // La regresión que motivó esto: el asistente contestaba "no hay una
    // primitiva disponible para cambiar el status" sobre una API que el server
    // sí soporta (`PUT /api/tasks/:id`). El contrato era lo que se quedaba
    // corto, no el backend.
    const ops = branches(['refine', 'build']).map((b) => b.properties.op.const)
    expect(ops).toContain('set-status')
  })

  it('interpola los statuses REALES del board como enum de params.status', () => {
    const setStatus = branches(['refine', 'build']).find(
      (b) => b.properties.op.const === 'set-status',
    )
    expect(setStatus?.properties.params.properties.status.enum).toEqual(['refine', 'build'])
    // Obligatorio en su rama: la API garantiza que un "set-status" llegue con
    // destino, en vez de que lo descubra el renderer al fallar.
    expect(setStatus?.required).toContain('params')
  })

  it('los statuses también entran en la prosa que el modelo lee', () => {
    const primitive = buildTaskUiContract({ statuses: ['refine', 'build'] }).primitives[0]!
    expect(primitive.description).toContain('refine, build')
  })

  it('retira la operación cuando no hay statuses — mejor sin botón que con uno que falla', () => {
    const ops = branches([]).map((b) => b.properties.op.const)
    expect(ops).toEqual(['run'])
  })

  it('`run` no declara params, así que su rama no los exige', () => {
    const run = branches(['refine']).find((b) => b.properties.op.const === 'run')
    expect(run?.properties.params).toBeUndefined()
    expect(run?.required).toEqual(['op', 'label', 'taskIds'])
  })

  it('cada operación del contrato tiene su implementación — el botón nunca queda mudo', () => {
    for (const branch of branches(['refine'])) {
      expect(findTaskUiOperation(branch.properties.op.const)).toBeDefined()
    }
  })
})
