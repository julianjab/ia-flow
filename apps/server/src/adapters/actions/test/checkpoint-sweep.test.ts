import { describe, expect, it, mock } from 'bun:test'
import type { RecoverableCheckpoint } from '@ia-flow/shared'
import { RunTaskNowError } from '../../../application/use-cases/RunTaskNowUseCase.js'
import { type CheckpointSweepDeps, createCheckpointSweep } from '../checkpoint-sweep.js'

function makeCheckpoint(over: Partial<RecoverableCheckpoint> = {}): RecoverableCheckpoint {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    taskTitle: 'T',
    projectId: 'p1',
    agentId: 'implementer',
    updatedAt: '2024-01-01T00:00:00.000Z',
    attempts: 1,
    resumable: true,
    stillOpen: true,
    ...over,
  }
}

function makeDeps(over: Partial<CheckpointSweepDeps> = {}): {
  deps: CheckpointSweepDeps
  runTaskNow: ReturnType<typeof mock>
  sourceFor: ReturnType<typeof mock>
} {
  const runTaskNow = mock(async () => ({ outcome: 'dispatched' as const, status: 'Build' }))
  const sourceFor = mock(() => ({ getItems: async () => [] }))
  return {
    runTaskNow,
    sourceFor,
    deps: {
      listRecoverableCheckpoints: async () => [],
      isRunning: () => false,
      sourceFor,
      runTaskNow,
      ...over,
    },
  }
}

describe('createCheckpointSweep — incidente d62fddc3 (checkpoint sync huérfano)', () => {
  it('redespacha un checkpoint sync resumible vía runTaskNow, con eventSource "checkpoint-sweep"', async () => {
    const cp = makeCheckpoint()
    const { deps, runTaskNow, sourceFor } = makeDeps({
      listRecoverableCheckpoints: async () => [cp],
    })

    await createCheckpointSweep(deps)()

    expect(sourceFor).toHaveBeenCalledWith('p1')
    expect(runTaskNow).toHaveBeenCalledTimes(1)
    expect(runTaskNow.mock.calls[0]?.[0]).toEqual({ taskId: 'task-1', projectId: 'p1' })
    expect(runTaskNow.mock.calls[0]?.[2]).toBe('checkpoint-sweep')
  })

  it('un segundo barrido sobre el mismo checkpoint no duplica el redispatch si ya está corriendo', async () => {
    // Simula la vuelta SIGUIENTE del sweep: el primer redispatch ya dejó la
    // task corriendo en este proceso (isRunning === true), así que el
    // segundo tick no debe volver a llamar a runTaskNow — es exactamente el
    // escenario "redispatch único, sin duplicar" del incidente.
    const cp = makeCheckpoint()
    const { deps, runTaskNow } = makeDeps({
      listRecoverableCheckpoints: async () => [cp],
      isRunning: (taskId) => taskId === 'task-1',
    })

    await createCheckpointSweep(deps)()

    expect(runTaskNow).not.toHaveBeenCalled()
  })

  it('ignora checkpoints no resumibles (edad o intentos agotados)', async () => {
    const { deps, runTaskNow } = makeDeps({
      listRecoverableCheckpoints: async () => [makeCheckpoint({ resumable: false })],
    })

    await createCheckpointSweep(deps)()

    expect(runTaskNow).not.toHaveBeenCalled()
  })

  it('ignora checkpoints sin projectId — no hay fuente que resolver', async () => {
    const { deps, runTaskNow } = makeDeps({
      listRecoverableCheckpoints: async () => [makeCheckpoint({ projectId: null })],
    })

    await createCheckpointSweep(deps)()

    expect(runTaskNow).not.toHaveBeenCalled()
  })

  it('un RunTaskNowError (ya corriendo, sin status, etc.) no interrumpe el barrido del resto', async () => {
    const cps = [makeCheckpoint({ taskId: 'task-1' }), makeCheckpoint({ taskId: 'task-2' })]
    const runTaskNow = mock(async (input: { taskId: string }) => {
      if (input.taskId === 'task-1') throw new RunTaskNowError('Ya hay un run en curso')
      return { outcome: 'dispatched' as const, status: 'Build' }
    })
    const { deps } = makeDeps({ listRecoverableCheckpoints: async () => cps, runTaskNow })

    await createCheckpointSweep(deps)()

    expect(runTaskNow).toHaveBeenCalledTimes(2)
  })

  it('un error inesperado de runTaskNow tampoco interrumpe el barrido del resto', async () => {
    const cps = [makeCheckpoint({ taskId: 'task-1' }), makeCheckpoint({ taskId: 'task-2' })]
    const runTaskNow = mock(async (input: { taskId: string }) => {
      if (input.taskId === 'task-1') throw new Error('DB caída')
      return { outcome: 'dispatched' as const, status: 'Build' }
    })
    const { deps } = makeDeps({ listRecoverableCheckpoints: async () => cps, runTaskNow })

    await createCheckpointSweep(deps)()

    expect(runTaskNow).toHaveBeenCalledTimes(2)
  })

  it('si sourceFor tira (proyecto sin fuente resoluble), no llama a runTaskNow para ese checkpoint', async () => {
    const sourceFor = mock(() => {
      throw new Error('sin fuente')
    })
    const { deps, runTaskNow } = makeDeps({
      listRecoverableCheckpoints: async () => [makeCheckpoint()],
      sourceFor,
    })

    await createCheckpointSweep(deps)()

    expect(runTaskNow).not.toHaveBeenCalled()
  })
})

describe('createCheckpointSweep — nunca toca una sesión async (issue #232)', () => {
  // El sweep confía en que `listRecoverableCheckpoints` (composition/actions.ts)
  // ya excluyó cualquier fila con `sessionId` — esta suite prueba que, aun así,
  // el sweep no distingue "sync" de "async" por su cuenta: sólo mira
  // `resumable`/`projectId`. La garantía real de que NUNCA llega un checkpoint
  // async acá vive en el filtro de `listRecoverableCheckpoints` (ver su
  // docstring) y en el gate independiente de `TaskDispatcher.hasOpenAsyncSession`,
  // que corre dentro de `runTaskNow` sin que este módulo tenga que saber nada
  // de sesiones.
  it('una lista vacía (todo filtrado aguas arriba) no dispara ningún redispatch', async () => {
    const { deps, runTaskNow } = makeDeps({ listRecoverableCheckpoints: async () => [] })

    await createCheckpointSweep(deps)()

    expect(runTaskNow).not.toHaveBeenCalled()
  })
})
