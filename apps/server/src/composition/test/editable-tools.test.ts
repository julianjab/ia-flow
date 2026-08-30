import { describe, expect, test } from 'bun:test'
import type { NamedAction } from '@ia-flow/shared'
import { getTool, registerTool, setToolDescription } from '@ia-flow/tools'
import { applyEditableTools, isBuiltInName, toolFromAction } from '../editable-tools.js'

// Registrada a mano para tener una "built-in" estable que no dependa del roster
// real — si mañana se renombra una tool del catálogo, este test no se cae.
registerTool({
  name: '__probe_builtin__',
  description: 'la original',
  input_schema: { type: 'object', properties: {} },
  execute: async () => 'ok',
})

const action = (over: Partial<NamedAction> = {}): NamedAction =>
  ({
    id: 'a1',
    body: { action: 'emit', type: 'algo' },
    ...over,
  }) as NamedAction

const defined = (over = {}) =>
  ({
    kind: 'defined' as const,
    name: 'deploy_staging',
    description: 'Deploya a staging',
    actionId: 'a1',
    ...over,
  }) as never

describe('applyEditableTools', () => {
  test('un override cambia la descripción de una built-in', async () => {
    await applyEditableTools({
      listTools: async () => [
        { kind: 'override', name: '__probe_builtin__', description: 'la ajustada' } as never,
      ],
      getAction: async () => null,
    })

    expect(getTool('__probe_builtin__')?.description).toBe('la ajustada')
    setToolDescription('__probe_builtin__', 'la original')
  })

  // Tapar una built-in cambiaría en silencio lo que hace un agente que la
  // declara — el modo de falla más caro de esta feature.
  test('una tool definida NO puede tapar una built-in', async () => {
    await applyEditableTools({
      listTools: async () => [defined({ name: '__probe_builtin__' })],
      getAction: async () => action(),
    })

    expect(getTool('__probe_builtin__')?.description).toBe('la original')
  })

  // Una fila rota no puede dejar al daemon sin ninguna tool.
  test('una tool sin su acción se saltea y el resto se aplica', async () => {
    await applyEditableTools({
      listTools: async () => [
        defined({ name: 'sin_accion', actionId: 'no-existe' }),
        { kind: 'override', name: '__probe_builtin__', description: 'sigo aplicando' } as never,
      ],
      getAction: async (id) => (id === 'no-existe' ? null : action()),
    })

    expect(getTool('sin_accion')).toBeUndefined()
    expect(getTool('__probe_builtin__')?.description).toBe('sigo aplicando')
    setToolDescription('__probe_builtin__', 'la original')
  })

  // Un override sobre un nombre removido en un update no es un error del
  // daemon: se avisa y sigue.
  test('un override sobre algo que no existe no rompe', async () => {
    await applyEditableTools({
      listTools: async () => [
        { kind: 'override', name: 'ya_no_existe', description: 'x' } as never,
      ],
      getAction: async () => null,
    })
    expect(getTool('ya_no_existe')).toBeUndefined()
  })

  test('si no se puede leer la config, quedan las built-in', async () => {
    await applyEditableTools({
      listTools: async () => {
        throw new Error('DB caída')
      },
      getAction: async () => null,
    })
    expect(getTool('__probe_builtin__')).toBeDefined()
  })

  test('registra la tool definida y queda invocable', async () => {
    await applyEditableTools({
      listTools: async () => [defined()],
      getAction: async () => action(),
    })

    const t = getTool('deploy_staging')
    expect(t?.description).toBe('Deploya a staging')
    // Sólo sync: la acción corre en el daemon, y en terminal el modelo
    // esperaría que corriera donde está su CLI.
    expect(t?.providerKinds).toEqual(['sync'])
  })
})

describe('toolFromAction', () => {
  test('la acción se ejecuta por el mismo camino que la corre una regla', async () => {
    // Sin handler registrado para `emit` en este proceso de test, el resultado
    // lo dice en vez de fingir que corrió.
    const t = toolFromAction(defined(), action({ body: { action: 'inexistente' } as never }))
    const out = await t.execute({}, { repoPaths: {} } as never)
    expect(String(out)).toContain('no sabe ejecutar')
  })

  test('sin inputSchema declarado, expone un objeto vacío en vez de undefined', () => {
    expect(toolFromAction(defined(), action()).input_schema).toEqual({
      type: 'object',
      properties: {},
    })
  })
})

describe('isBuiltInName', () => {
  test('reconoce las registradas', () => {
    expect(isBuiltInName('__probe_builtin__')).toBe(true)
    expect(isBuiltInName('nombre_inventado')).toBe(false)
  })
})
