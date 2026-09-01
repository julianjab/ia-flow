import { afterEach, describe, expect, it } from 'bun:test'
import type { ToolContext } from '../../contract.js'
import { getTool, resolveExecutableTool } from '../../engine.js'
import { type RunAgentPort, setRunAgentPort } from '../run-agent.js'
import '../run-agent.js'

const run = (input: unknown, ctx: Partial<ToolContext> = {}) =>
  getTool('run_agent')!.execute(input, {
    repoPaths: {},
    taskId: 't1',
    runId: 'run-padre',
    agentId: 'planner',
    ...ctx,
  } as ToolContext)

function port(impl?: Partial<RunAgentPort>) {
  const calls: Array<Record<string, unknown>> = []
  setRunAgentPort({
    runAgent: async (i) => {
      calls.push(i)
      return { ok: true, output: `hecho por ${i.agentId}` }
    },
    ...impl,
  })
  return calls
}

afterEach(() => setRunAgentPort(null))

describe('run_agent', () => {
  it('delega y devuelve lo que produjo el hijo', async () => {
    const calls = port()
    expect(await run({ agentId: 'tester', brief: 'corré los tests' })).toBe('hecho por tester')
    expect(calls[0]).toMatchObject({
      taskId: 't1',
      agentId: 'tester',
      brief: 'corré los tests',
      parentRunId: 'run-padre',
    })
  })

  // El hijo no ve la conversación del padre: sin brief no tiene con qué
  // trabajar, y dejarlo pasar produce un run que quema presupuesto sin rumbo.
  it('exige un brief', async () => {
    port()
    expect(await run({ agentId: 'tester' })).toContain('falta `brief`')
    expect(await run({ agentId: 'tester', brief: '   ' })).toContain('falta `brief`')
  })

  // El freno de profundidad lo cortaría recién tres niveles más abajo; acá es
  // gratis, y siempre es un error de razonamiento.
  it('rechaza que un agente se delegue a sí mismo', async () => {
    const calls = port()
    expect(await run({ agentId: 'planner', brief: 'x' }, { agentId: 'planner' })).toContain(
      'sos vos',
    )
    expect(calls).toHaveLength(0)
  })

  it('propaga la profundidad del padre, y 0 cuando no viene', async () => {
    const calls = port()
    await run({ agentId: 'tester', brief: 'x' }, { agentDepth: 2 })
    expect(calls[0]?.parentDepth).toBe(2)

    await run({ agentId: 'tester', brief: 'x' })
    expect(calls[1]?.parentDepth).toBe(0)
  })

  // Que un hijo no corra es información que el padre puede usar (probar con
  // otro, seguir sin él), no un fallo del padre.
  it('un hijo que no corre vuelve como texto, no como excepción', async () => {
    port({ runAgent: async () => ({ ok: false, reason: 'no hay capacidad ahora mismo' }) })
    const out = await run({ agentId: 'tester', brief: 'x' })
    expect(out).toContain("El agente 'tester' no pudo correr")
    expect(out).toContain('no hay capacidad')
  })

  it('fuera de un run avisa en vez de intentar', async () => {
    port()
    expect(await run({ agentId: 'tester', brief: 'x' }, { runId: undefined })).toContain(
      'sólo funciona dentro de un run',
    )
  })

  it('sin port cableado no finge que delegó', async () => {
    setRunAgentPort(null)
    expect(await run({ agentId: 'tester', brief: 'x' })).toContain('no está disponible')
  })

  // En terminal el CLI ya trae su propio mecanismo de sub-agentes, y esta tool
  // despacharía en el proceso equivocado.
  it('no se ofrece a los providers async', () => {
    const ctx = { repoPaths: {}, providerKind: 'async' } as ToolContext
    expect(resolveExecutableTool('run_agent', ctx)).toBeUndefined()
    expect(
      resolveExecutableTool('run_agent', { repoPaths: {}, providerKind: 'sync' }),
    ).toBeDefined()
  })
})
