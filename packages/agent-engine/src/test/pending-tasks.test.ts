import { describe, expect, it } from 'bun:test'
import type { TaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import {
  PendingTaskRegistry,
  getPendingTask,
  registerPendingTask,
  removePendingTask,
  waitForFinish,
} from '../pending-tasks.js'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 't',
    description: '',
    type: 'functional',
    repos: [],
    status: 'Todo',
    labels: [],
    assignees: [],
    fields: {},
    ...overrides,
  } as Task
}

const noopManager = {
  setAgentWorking: async (t: Task) => t,
} as unknown as TaskSource

describe('pending-tasks waitForFinish', () => {
  it('resolves with the final task snapshot when removePendingTask fires', async () => {
    const task = makeTask({ id: 'wait-1' })
    registerPendingTask(task.id, {
      task,
      manager: noopManager,
      broadcast: () => {},
      initialStatus: 'Todo',
    })
    const p = waitForFinish(task.id)
    expect(p).not.toBeNull()

    // Simulate complete_task mutating the task via the pending entry
    // before removing it, as the real tool does.
    const entry = getPendingTask(task.id)!
    entry.task = { ...entry.task, status: 'Done' }
    removePendingTask(task.id, { finalizedByTool: true })

    const result = await p!
    expect(result.task.status).toBe('Done')
    expect(result.finalizedByTool).toBe(true)
    expect(result.cancelled).toBe(false)
  })

  it('propagates cancelled flag from the pending entry', async () => {
    const task = makeTask({ id: 'wait-2' })
    registerPendingTask(task.id, {
      task,
      manager: noopManager,
      broadcast: () => {},
      initialStatus: 'Todo',
      cancelled: true,
    })
    const p = waitForFinish(task.id)!
    removePendingTask(task.id)
    const result = await p
    expect(result.cancelled).toBe(true)
    expect(result.finalizedByTool).toBe(false)
  })

  it('returns null when the task was never registered', () => {
    expect(waitForFinish('never-registered')).toBeNull()
  })

  it('a caller that awaits after removal still gets the resolved promise if it grabbed it first', async () => {
    const task = makeTask({ id: 'wait-3' })
    registerPendingTask(task.id, {
      task,
      manager: noopManager,
      broadcast: () => {},
      initialStatus: 'Todo',
    })
    const p = waitForFinish(task.id)!
    removePendingTask(task.id, { finalizedByTool: true })
    // waitForFinish now returns null (entry cleaned up), but the caller who
    // grabbed `p` before removal must still be able to await it.
    expect(waitForFinish(task.id)).toBeNull()
    const result = await p
    expect(result.finalizedByTool).toBe(true)
  })
})

// El `Map` de runs en vuelo muere con el proceso; la sesión del agente no.
// `resolve` es lo que convierte ese Map en un cache: cuando no tiene la
// entrada, la reconstruye desde almacenamiento durable.
// Es la única salida que tiene `Agent.run` de su `await waitForFinish`: sin
// esto, un run que el watchdog suelta por liveness desconocida se queda
// bloqueado ahí con el lock de la task y los slots del agente, del proyecto y
// del provider tomados hasta el próximo reinicio.
describe('pending-tasks — soltar un run desbloquea al orquestador', () => {
  it('remove con motivo resuelve waitForFinish y lo propaga', async () => {
    const task = makeTask({ id: 'unblock-1' })
    registerPendingTask(task.id, {
      task,
      manager: noopManager,
      broadcast: () => {},
      initialStatus: 'Todo',
    })
    const finished = waitForFinish(task.id)

    removePendingTask(task.id, { cancelled: true, reason: 'watchdog: liveness desconocida' })

    const result = await finished
    expect(result?.cancelled).toBe(true)
    expect(result?.reason).toBe('watchdog: liveness desconocida')
  })
})

describe('pending-tasks resolve — rehidratación', () => {
  it('sin rehidratador se comporta como get', async () => {
    const registry = new PendingTaskRegistry()
    expect(await registry.resolve('no-existe')).toBeUndefined()
  })

  it('un hit en memoria no toca el rehidratador', async () => {
    const registry = new PendingTaskRegistry()
    let calls = 0
    registry.setRehydrator(async () => {
      calls += 1
      return undefined
    })
    const task = makeTask({ id: 'hot-1' })
    registry.register(task.id, {
      task,
      manager: noopManager,
      broadcast: () => {},
      initialStatus: 'Todo',
    })

    const resolved = await registry.resolve(task.id)

    expect(resolved?.entry.task.id).toBe('hot-1')
    expect(calls).toBe(0)
  })

  it('una entrada cancelada se resuelve pero congelada: acepta el cierre, no transiciona', async () => {
    const registry = new PendingTaskRegistry()
    const task = makeTask({ id: 'cancel-1' })
    registry.register(task.id, {
      task,
      manager: noopManager,
      broadcast: () => {},
      initialStatus: 'Todo',
      cancelled: true,
    })

    const resolved = await registry.resolve(task.id)

    expect(resolved?.entry).toBeDefined()
    expect(resolved?.freeze).toBeTruthy()
  })

  it('un miss reconstruye desde el rehidratador y queda cacheado como rehydrated', async () => {
    const registry = new PendingTaskRegistry()
    const task = makeTask({ id: 'cold-1' })
    let calls = 0
    registry.setRehydrator(async () => {
      calls += 1
      return {
        entry: {
          task,
          manager: noopManager,
          broadcast: () => {},
          initialStatus: 'Todo',
        },
      }
    })

    const first = await registry.resolve('cold-1')
    const second = await registry.resolve('cold-1')

    expect(first?.entry.rehydrated).toBe(true)
    expect(second?.entry.task.id).toBe('cold-1')
    // La segunda ya sale del cache: rehidratar pega contra el source.
    expect(calls).toBe(1)
  })

  it('dos llamadas concurrentes rehidratan una sola vez', async () => {
    const registry = new PendingTaskRegistry()
    const task = makeTask({ id: 'race-1' })
    let calls = 0
    registry.setRehydrator(async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 5))
      return {
        entry: { task, manager: noopManager, broadcast: () => {}, initialStatus: 'Todo' },
      }
    })

    const [a, b] = await Promise.all([registry.resolve('race-1'), registry.resolve('race-1')])

    expect(a?.entry.task.id).toBe('race-1')
    expect(b?.entry.task.id).toBe('race-1')
    expect(calls).toBe(1)
  })

  it('propaga alreadyClosed — un cierre repetido no debe duplicar nada', async () => {
    const registry = new PendingTaskRegistry()
    const task = makeTask({ id: 'dup-1' })
    registry.setRehydrator(async () => ({
      entry: { task, manager: noopManager, broadcast: () => {}, initialStatus: 'Todo' },
      alreadyClosed: true,
    }))

    expect((await registry.resolve('dup-1'))?.alreadyClosed).toBe(true)
  })
})

describe('pending-tasks — una entrada rehidratada no es un run de este proceso', () => {
  it('no aparece en list(): no le come un slot de capacidad a su agente', async () => {
    const registry = new PendingTaskRegistry()
    const task = makeTask({ id: 'cap-1' })
    registry.setRehydrator(async () => ({
      entry: {
        task,
        manager: noopManager,
        broadcast: () => {},
        initialStatus: 'Todo',
        agentId: 'implementer',
        providerId: 'remote:mac',
      },
    }))

    expect(await registry.resolve('cap-1')).toBeDefined()

    // Los caps de concurrencia cuentan sobre `list()` (ver capacity.ts): si
    // la reconstrucción apareciera acá, cerrar un run viejo bloquearía
    // dispatches nuevos del mismo agente.
    expect(registry.list()).toHaveLength(0)
    expect(registry.get('cap-1')).toBeUndefined()
  })

  it('remove también la olvida — el cierre no queda cacheado', async () => {
    const registry = new PendingTaskRegistry()
    const task = makeTask({ id: 'drop-1' })
    let calls = 0
    registry.setRehydrator(async () => {
      calls += 1
      return {
        entry: { task, manager: noopManager, broadcast: () => {}, initialStatus: 'Todo' },
      }
    })

    await registry.resolve('drop-1')
    registry.remove('drop-1', { finalizedByTool: true })
    await registry.resolve('drop-1')

    expect(calls).toBe(2)
  })
})

describe('pending-tasks resolve — el cache no puede perder el contrato', () => {
  it('devuelve el ResolvedPendingTask completo, no sólo la entrada', async () => {
    // Un tool anterior del mismo cierre (add_task_comment, set_task_field)
    // puebla el cache. Si acá se perdiera `finalize`, el complete_task que
    // sigue no podría cerrar la fila y quedaría abierta para siempre; si se
    // perdiera `freeze`, pisaría el estado que otro run ya decidió.
    const registry = new PendingTaskRegistry()
    const task = makeTask({ id: 'cache-1' })
    registry.setRehydrator(async () => ({
      entry: { task, manager: noopManager, broadcast: () => {}, initialStatus: 'Todo' },
      freeze: 'otro run abierto',
      finalize: () => {},
    }))

    await registry.resolve('cache-1')
    const second = await registry.resolve('cache-1')

    expect(second?.freeze).toBe('otro run abierto')
    expect(typeof second?.finalize).toBe('function')
  })

  it('dos runs sobre la misma tarea no comparten resolución', async () => {
    const registry = new PendingTaskRegistry()
    const task = makeTask({ id: 'two-runs' })
    registry.setRehydrator(async (_taskId, runId) => ({
      entry: {
        task,
        manager: noopManager,
        broadcast: () => {},
        initialStatus: 'Todo',
        runId,
        executionId: runId === 'run-viejo' ? 'exec-1' : 'exec-2',
      },
    }))

    const viejo = await registry.resolve('two-runs', 'run-viejo')
    const nuevo = await registry.resolve('two-runs', 'run-nuevo')

    expect(viejo?.entry.executionId).toBe('exec-1')
    expect(nuevo?.entry.executionId).toBe('exec-2')
  })

  it('remove olvida las entradas de todos los runs de esa tarea', async () => {
    const registry = new PendingTaskRegistry()
    const task = makeTask({ id: 'drop-all' })
    let calls = 0
    registry.setRehydrator(async () => {
      calls += 1
      return {
        entry: { task, manager: noopManager, broadcast: () => {}, initialStatus: 'Todo' },
      }
    })

    await registry.resolve('drop-all', 'run-a')
    registry.remove('drop-all', { finalizedByTool: true })
    await registry.resolve('drop-all', 'run-a')

    expect(calls).toBe(2)
  })
})
