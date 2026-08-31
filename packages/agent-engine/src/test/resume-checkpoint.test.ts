import { describe, expect, it, mock } from 'bun:test'
import type { IAgentProvider, ProviderInput } from '@ia-flow/ai-providers'
import type { ITaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { AgentOrchestrator } from '../AgentOrchestrator.js'
import type {
  IBroadcast,
  IExecutionLogRepository,
  IProjectConfigRepository,
  IProviderRegistry,
  IRepoRepository,
  RunCheckpointPort,
} from '../contract.js'

function makeTask(): Task {
  return {
    id: 'task-resume-1',
    title: 't',
    description: '',
    type: 'technical',
    repos: [],
    status: 'InProgress',
    projectId: 'p1',
  } as unknown as Task
}

/** Devuelve el orquestador más el `ProviderInput` con el que se llamó al
 *  provider — que es donde se ve si el run entró con la conversación vieja o
 *  arrancó de cero. */
function makeDeps(checkpoints: RunCheckpointPort) {
  let seen: ProviderInput | undefined

  const provider: IAgentProvider = {
    id: 'anthropic-api',
    kind: 'sync',
    name: 'test',
    description: '',
    run: async (input: ProviderInput) => {
      seen = input
      return { content: 'listo', mode: 'api' as const }
    },
  }
  const providers = {
    get: (id: string) => (id === 'anthropic-api' ? provider : undefined),
    list: () => [provider],
  } as unknown as IProviderRegistry

  const configRepo = {
    getConfig: async () => ({
      agents: [{ id: 'implementer', provider: 'anthropic-api', prompt: 'x', tools: [] }],
      statuses: [{ name: 'InProgress' }],
    }),
  } as unknown as IProjectConfigRepository

  const repoRepo = { list: () => [], listByProject: () => [] } as unknown as IRepoRepository

  const manager = {
    applyTransition: async (t: Task) => t,
    saveOutput: async (t: Task) => t,
    setAgentWorking: async (t: Task) => t,
    postError: async () => {},
    getCurrentStatus: async () => 'InProgress',
  } as unknown as ITaskSource

  const executionLogRepo: IExecutionLogRepository = {
    insert: () => {},
    update: () => {},
    list: () => [],
    listActive: () => [],
    getById: () => null,
    sweepOrphaned: () => [],
    listDistinctSources: () => [],
  }

  const orch = new AgentOrchestrator(
    providers,
    configRepo,
    repoRepo,
    { send: () => {} } as IBroadcast,
    undefined,
    executionLogRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    checkpoints,
  )

  return { orch, manager, seen: () => seen }
}

function port(over: Partial<RunCheckpointPort> = {}): RunCheckpointPort {
  return {
    save: async () => {},
    getByTask: async () => null,
    delete: async () => {},
    ...over,
  }
}

describe('AgentOrchestrator — reanudar desde el checkpoint', () => {
  it('entra al run con la conversación que dejó el run anterior', async () => {
    const del = mock(async () => {})
    const { orch, manager, seen } = makeDeps(
      port({
        getByTask: async () => ({
          runId: 'viejo',
          agentId: 'implementer',
          state: { messages: [{ role: 'user', content: 'donde iba' }] },
          attempts: 0,
        }),
        delete: del,
      }),
    )

    await orch.runAgent(makeTask(), manager, 'implementer')

    expect(seen()?.resumeMessages).toEqual([{ role: 'user', content: 'donde iba' }])
    // La fila vieja se borra al reanudarla: el run nuevo guarda bajo otro
    // `runId`, así que dejarla ahí la volvería a ofrecer para siempre.
    expect(del.mock.calls.some((c) => (c as unknown as unknown[])[0] === 'viejo')).toBe(true)
  })

  it('descarta el checkpoint de OTRO agente', async () => {
    // La conversación es de quien la escribió: dársela a otro agente sería
    // darle un contexto que no es suyo y un prompt que nunca vio.
    const { orch, manager, seen } = makeDeps(
      port({
        getByTask: async () => ({
          runId: 'viejo',
          agentId: 'refiner',
          state: { messages: [{ role: 'user', content: 'contexto ajeno' }] },
          attempts: 0,
        }),
      }),
    )

    await orch.runAgent(makeTask(), manager, 'implementer')

    expect(seen()?.resumeMessages).toBeUndefined()
  })

  it('deja de reanudar pasado el tope de intentos', async () => {
    // Un run que hace crashear al proceso se reanudaría al bootear, lo
    // volvería a matar, y el reinicio quedaría en bucle.
    const { orch, manager, seen } = makeDeps(
      port({
        getByTask: async () => ({
          runId: 'viejo',
          agentId: 'implementer',
          state: { messages: [{ role: 'user', content: 'veneno' }] },
          attempts: 3,
        }),
      }),
    )

    await orch.runAgent(makeTask(), manager, 'implementer')

    expect(seen()?.resumeMessages).toBeUndefined()
  })

  it('un checkpoint vacío no cuenta como reanudable', async () => {
    const { orch, manager, seen } = makeDeps(
      port({
        getByTask: async () => ({
          runId: 'viejo',
          agentId: 'implementer',
          state: { messages: [] },
          attempts: 0,
        }),
      }),
    )

    await orch.runAgent(makeTask(), manager, 'implementer')

    expect(seen()?.resumeMessages).toBeUndefined()
  })

  it('si el store falla al leer, el run arranca de cero en vez de no arrancar', async () => {
    const { orch, manager, seen } = makeDeps(
      port({
        getByTask: async () => {
          throw new Error('disco')
        },
      }),
    )

    const outcome = await orch.runAgent(makeTask(), manager, 'implementer')

    expect(outcome).toBe('dispatched')
    expect(seen()?.resumeMessages).toBeUndefined()
  })

  it('borra el checkpoint cuando el run termina', async () => {
    const del = mock(async () => {})
    const { orch, manager } = makeDeps(port({ delete: del }))

    await orch.runAgent(makeTask(), manager, 'implementer')

    expect(del).toHaveBeenCalled()
  })
})
