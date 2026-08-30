import { describe, expect, it } from 'vitest'
import { inputSchemaToToolParams, toolParamsToInputSchema } from '../tools-crud.js'

describe('toolParamsToInputSchema', () => {
  it('arma el JSON Schema que espera la API del modelo', () => {
    expect(
      toolParamsToInputSchema([
        { name: 'branch', type: 'string', description: 'Rama a desplegar', required: true },
        { name: 'force', type: 'boolean' },
      ]),
    ).toEqual({
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Rama a desplegar' },
        force: { type: 'boolean' },
      },
      required: ['branch'],
    })
  })

  // Un `required: []` es ruido en el prompt del modelo: sin obligatorios, el
  // campo no va.
  it('sin obligatorios no emite required', () => {
    expect(toolParamsToInputSchema([{ name: 'x', type: 'string' }])).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
    })
  })

  it('sin parámetros es un objeto vacío, no undefined', () => {
    expect(toolParamsToInputSchema([])).toEqual({ type: 'object', properties: {} })
  })
})

describe('inputSchemaToToolParams', () => {
  it('cierra el round-trip', () => {
    const params = [
      { name: 'branch', type: 'string' as const, description: 'La rama', required: true },
      { name: 'retries', type: 'number' as const },
    ]
    expect(inputSchemaToToolParams(toolParamsToInputSchema(params))).toEqual(params)
  })

  it('una tool sin schema no tiene parámetros', () => {
    expect(inputSchemaToToolParams(undefined)).toEqual([])
    expect(inputSchemaToToolParams({ type: 'object', properties: {} })).toEqual([])
  })

  // El caso que justifica el `null`: abrir el editor sobre un schema escrito
  // por API y guardarlo lo destruiría en silencio.
  it('devuelve null ante lo que la lista no puede expresar', () => {
    expect(inputSchemaToToolParams({ type: 'object', properties: { a: { type: 'array' } } })).toBe(
      null,
    )
    expect(
      inputSchemaToToolParams({
        type: 'object',
        properties: { a: { type: 'string', enum: ['x'] } },
      }),
    ).toBe(null)
    expect(
      inputSchemaToToolParams({ type: 'object', properties: {}, additionalProperties: false }),
    ).toBe(null)
    expect(inputSchemaToToolParams({ type: 'string' })).toBe(null)
    expect(inputSchemaToToolParams([{ type: 'object' }])).toBe(null)
  })

  // Un nombre que el modelo no puede escribir como clave no es representable
  // acá tampoco: mejor mandar a la API que reescribirlo.
  it('devuelve null ante un nombre que no es identificador', () => {
    expect(
      inputSchemaToToolParams({ type: 'object', properties: { 'con-guión': { type: 'string' } } }),
    ).toBe(null)
  })
})
