import { beforeEach, describe, expect, it } from 'bun:test'
import { removePendingTask } from '@ia-flow/agent-engine'
import type { ProjectSource, SourceItem, TaskSource } from '@ia-flow/issue-sources'
import type { ExecutionLog } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../../domain/ports/IExecutionLogRepository.js'
import { createPendingTaskRehydrator, reconcileOrphanedRuns } from '../pending-task-rehydrator.js'

const TASK_ID = 'I_task_1'

function row(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'exec-1',
    projectId: 'proj-1',
    taskId: TASK_ID,
    taskTitle: 'Título',
    agentId: 'implementer',
    providerId: 'remote:mac',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    outcome: null,
    errorMsg: null,
    stopReason: null,
    sessionKind: 'tmux',
    sessionId: 'iaflow-algo',
    source: null,
    initialStatus: 'Build',
    onFinish: '$set:Labels=+agent:review',
    onError: '$set:Labels=+blocked',
    ...overrides,
  } as ExecutionLog
}

function fakeRepo(rows: ExecutionLog[]): IExecutionLogRepository & { updates: unknown[] } {
  const updates: unknown[] = []
  return {
    updates,
    insert() {},
    update(id, patch) {
      updates.push({ id, patch })
      const target = rows.find((r) => r.id === id)
      if (target) Object.assign(target, patch)
    },
    list(filters) {
      return rows
        .filter((r) => (filters.taskId ? r.taskId === filters.taskId : true))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    },
    listActive() {
      return rows.filter((r) => r.finishedAt == null)
    },
    getById(id) {
      return rows.find((r) => r.id === id) ?? null
    },
    sweepOrphaned() {
      return []
    },
    listDistinctSources() {
      return []
    },
  } as IExecutionLogRepository & { updates: unknown[] }
}

function fakeSource(items: SourceItem[]): ProjectSource {
  return {
    kind: 'github-issues',
    async getStatuses() {
      return []
    },
    async getItems() {
      return items
    },
    getTransitionManager() {
      return {
        async setAgentWorking(t: unknown) {
          return t
        },
      } as unknown as TaskSource
    },
  } as unknown as ProjectSource
}

const ITEM: SourceItem = { id: TASK_ID, title: 'Título', status: 'Build' }

beforeEach(() => {
  removePendingTask(TASK_ID)
})

describe('createPendingTaskRehydrator', () => {
  it('reconstruye la entrada del run desde execution_logs', async () => {
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([row()]),
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    const resolved = await rehydrate(TASK_ID)

    expect(resolved?.entry.task.id).toBe(TASK_ID)
    expect(resolved?.entry.agentId).toBe('implementer')
    expect(resolved?.entry.executionId).toBe('exec-1')
    // La transición que se aplica es la que el run PACTÓ al arrancar, no la
    // que el AgentDefinition diga hoy: el agente se puede editar mientras el
    // run corre.
    expect(resolved?.entry.onFinish).toBe('$set:Labels=+agent:review')
    expect(resolved?.entry.initialStatus).toBe('Build')
    expect(resolved?.freeze).toBeUndefined()
    expect(resolved?.alreadyClosed).toBe(false)
  })

  // El caso exacto del incidente: el daemon reinició, cerró la fila como
  // huérfana, y el agente —vivo del otro lado— llega después con su cierre.
  it('un run cerrado como huérfano por un reinicio igual se puede cerrar', async () => {
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([
        row({
          finishedAt: '2026-01-01T00:10:00.000Z',
          outcome: 'error',
          errorMsg: 'orphaned: server restart before finalize',
        }),
      ]),
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    const resolved = await rehydrate(TASK_ID)

    expect(resolved?.entry).toBeDefined()
    // `outcome: 'error'` con mensaje de huérfano NO es un cierre del agente:
    // el cierre del agente se marca con `finalizedByTool`. Si esto diera
    // `true`, se descartaría como duplicado justo el caso del incidente.
    expect(resolved?.alreadyClosed).toBe(false)
  })

  it('un run que ya cerró un tool es idempotente: alreadyClosed', async () => {
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([
        row({
          finishedAt: '2026-01-01T00:10:00.000Z',
          outcome: 'success',
          finalizedByTool: true,
        }),
      ]),
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    expect((await rehydrate(TASK_ID))?.alreadyClosed).toBe(true)
  })

  it('finalize cierra la fila del run — nadie más lo va a hacer', async () => {
    const repo = fakeRepo([row()])
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: repo,
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    const resolved = await rehydrate(TASK_ID)
    resolved?.finalize?.('success')

    expect(repo.updates).toHaveLength(1)
    expect(repo.getById('exec-1')?.outcome).toBe('success')
    expect(repo.getById('exec-1')?.finalizedByTool).toBe(true)
    // Y un segundo cierre ya se reconoce como duplicado.
    expect((await rehydrate(TASK_ID))?.alreadyClosed).toBe(true)
  })

  it('con otro run abierto encima, congela la transición', async () => {
    // El watchdog soltó el run viejo, pasó el cooldown, el daemon
    // re-despachó. El cierre tardío del viejo no puede mover la tarea por
    // debajo del que está corriendo.
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([
        row({ id: 'exec-1', startedAt: '2026-01-01T00:00:00.000Z' }),
        row({ id: 'exec-2', startedAt: '2026-01-01T01:00:00.000Z', agentId: 'ci-watcher' }),
      ]),
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    const resolved = await rehydrate(TASK_ID)

    expect(resolved?.freeze).toContain('otro run abierto')
  })

  it('no toca runs de otro proceso: los cierra su dueño', async () => {
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([row({ source: 'otro-container' })]),
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
      ownSource: null,
    })

    expect(await rehydrate(TASK_ID)).toBeUndefined()
  })

  it('sin fila, no hay nada que reconstruir', async () => {
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([]),
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    expect(await rehydrate(TASK_ID)).toBeUndefined()
  })

  it('si el source explota, no rompe el cierre — devuelve undefined', async () => {
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([row()]),
      sourceFor: () => {
        throw new Error('GitHub caído')
      },
      broadcast: () => {},
    })

    expect(await rehydrate(TASK_ID)).toBeUndefined()
  })
})

describe('reconcileOrphanedRuns', () => {
  it('deja abiertos los runs con sesión async: su agente todavía puede cerrarlos', () => {
    const repo = fakeRepo([row({ sessionId: 'iaflow-viva' })])

    const { closed, kept } = reconcileOrphanedRuns({ executionLogRepo: repo, reason: 'restart' })

    expect(closed).toBe(0)
    expect(kept).toHaveLength(1)
    expect(repo.updates).toHaveLength(0)
  })

  it('cierra los runs sin sesión: su proceso murió con el daemon', () => {
    const repo = fakeRepo([row({ sessionKind: null, sessionId: null })])

    const { closed, kept } = reconcileOrphanedRuns({ executionLogRepo: repo, reason: 'restart' })

    expect(closed).toBe(1)
    expect(kept).toHaveLength(0)
    expect(repo.updates).toHaveLength(1)
  })

  it('no toca filas ya cerradas', () => {
    const repo = fakeRepo([row({ finishedAt: '2026-01-01T00:10:00.000Z', outcome: 'success' })])

    const { closed, kept } = reconcileOrphanedRuns({ executionLogRepo: repo, reason: 'restart' })

    expect(closed).toBe(0)
    expect(kept).toHaveLength(0)
  })
})

describe('createPendingTaskRehydrator — casos que no se pueden reconstruir', () => {
  it('un source que no aplica transiciones no sirve para cerrar', async () => {
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([row()]),
      sourceFor: () =>
        ({
          kind: 'local',
          async getItems() {
            return [ITEM]
          },
        }) as unknown as ProjectSource,
      broadcast: () => {},
    })

    expect(await rehydrate(TASK_ID)).toBeUndefined()
  })

  it('si el issue ya no está en el source, no hay contra qué aplicar', async () => {
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([row()]),
      sourceFor: () => fakeSource([]),
      broadcast: () => {},
    })

    expect(await rehydrate(TASK_ID)).toBeUndefined()
  })

  it('una fila sin projectId no se puede resolver a un source', async () => {
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([row({ projectId: '' })]),
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    expect(await rehydrate(TASK_ID)).toBeUndefined()
  })

  it('sin las columnas de la migración 048 cae al status de ahora, no rompe', async () => {
    // Filas viejas: `initial_status` nulo equivale a "nadie lo movió", que
    // deja que el onFinish se aplique — el comportamiento conservador.
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([row({ initialStatus: null, onFinish: null, onError: null })]),
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    const resolved = await rehydrate(TASK_ID)

    expect(resolved?.entry.initialStatus).toBe('Build')
    expect(resolved?.entry.onFinish).toBeUndefined()
  })
})
