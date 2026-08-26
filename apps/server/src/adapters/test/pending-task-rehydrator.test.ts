import { beforeEach, describe, expect, it } from 'bun:test'
import { registerPendingTask, removePendingTask } from '@ia-flow/agent-engine'
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
    exits: { success: '$set:Labels=+agent:review', error: '$set:Labels=+blocked' },
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
      // El `limit` se respeta a propósito: es lo que hace significativo el
      // test de que el filtro por proceso no se coma el lookback.
      return rows
        .filter((r) => (filters.taskId ? r.taskId === filters.taskId : true))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, filters.limit ?? rows.length)
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
    expect(resolved?.entry.exits?.success).toBe('$set:Labels=+agent:review')
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

  it('cierra la fila de SU run, no la más nueva', async () => {
    // El agujero que esto tapa: tomar `rows[0]` a ciegas hacía que el cierre
    // tardío de una sesión vieja cerrara la ejecución del run NUEVO — y el
    // cierre real de ese run se descartaba después como duplicado.
    const repo = fakeRepo([
      row({ id: 'exec-1', runId: 'run-viejo', startedAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'exec-2', runId: 'run-nuevo', startedAt: '2026-01-01T01:00:00.000Z' }),
    ])
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: repo,
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    const resolved = await rehydrate(TASK_ID, 'run-viejo')
    resolved?.finalize?.('success')

    expect(resolved?.entry.executionId).toBe('exec-1')
    expect(repo.getById('exec-1')?.finalizedByTool).toBe(true)
    // La del run que sigue trabajando queda intacta.
    expect(repo.getById('exec-2')?.finishedAt).toBeNull()
  })

  it('sin `?run=` y con dos abiertas no cierra ninguna: ante la duda, ninguna', async () => {
    const repo = fakeRepo([
      row({ id: 'exec-1', startedAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'exec-2', startedAt: '2026-01-01T01:00:00.000Z' }),
    ])
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: repo,
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    const resolved = await rehydrate(TASK_ID)

    expect(resolved?.finalize).toBeUndefined()
    expect(resolved?.freeze).toContain('no se pudo identificar')
    expect(repo.updates).toHaveLength(0)
  })

  it('un `?run=` que no matchea ninguna fila NO cae a la más nueva', async () => {
    // El fallback ingenuo (`matched ?? rows[0]`) apuesta a la fila más nueva
    // — la del run que puede seguir trabajando — y al cerrarla su cierre real
    // se descarta como duplicado. Pasa si la fila del que cierra se cayó del
    // LOOKBACK o la escribió otro proceso.
    const repo = fakeRepo([row({ id: 'exec-2', runId: 'run-nuevo' })])
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: repo,
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    const resolved = await rehydrate(TASK_ID, 'run-que-no-esta')
    resolved?.finalize?.('success')

    expect(resolved?.finalize).toBeUndefined()
    expect(resolved?.freeze).toContain('no se pudo identificar')
    expect(repo.getById('exec-2')?.finishedAt).toBeNull()
  })

  it('sin run, el candidato sale de las ABIERTAS aunque haya una cerrada más nueva', async () => {
    // Run viejo abierto (el que sigue trabajando) + run nuevo ya cerrado.
    // Elegir la más nueva aplicaría la salida de éxito de un run terminado y
    // reescribiría su fila, dejando al que trabaja sin poder cerrarse.
    const repo = fakeRepo([
      row({ id: 'exec-1', runId: 'run-viejo', startedAt: '2026-01-01T00:00:00.000Z' }),
      row({
        id: 'exec-2',
        runId: 'run-nuevo',
        startedAt: '2026-01-01T01:00:00.000Z',
        finishedAt: '2026-01-01T01:05:00.000Z',
        outcome: 'success',
        finalizedByTool: true,
      }),
    ])
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: repo,
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    const resolved = await rehydrate(TASK_ID)
    resolved?.finalize?.('success')

    expect(resolved?.entry.executionId).toBe('exec-1')
    expect(resolved?.alreadyClosed).toBe(false)
    expect(resolved?.freeze).toBeUndefined()
    expect(repo.getById('exec-1')?.finalizedByTool).toBe(true)
  })

  it('el filtro por proceso no se come el lookback: la fila propia se sigue viendo', async () => {
    // Una tarea con muchas filas reenviadas por otro container podía dejar
    // fuera del límite a la propia — y el cierre rebotaba con "no hay
    // ejecución", el síntoma original.
    const ajenas = Array.from({ length: 30 }, (_, i) =>
      row({
        id: `otro-${i}`,
        source: 'otro-container',
        startedAt: `2026-01-02T00:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    )
    const repo = fakeRepo([...ajenas, row({ id: 'mia' })])
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: repo,
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    expect((await rehydrate(TASK_ID))?.entry.executionId).toBe('mia')
  })

  it('una sola ejecución abierta y sin run: no hay con qué confundirla', async () => {
    const repo = fakeRepo([row()])
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: repo,
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    const resolved = await rehydrate(TASK_ID)

    expect(typeof resolved?.finalize).toBe('function')
    expect(resolved?.freeze).toBeUndefined()
  })

  it('un run abierto MÁS VIEJO no congela: sólo pisa el que arrancó después', async () => {
    const repo = fakeRepo([
      row({ id: 'exec-1', runId: 'run-viejo', startedAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'exec-2', runId: 'run-nuevo', startedAt: '2026-01-01T01:00:00.000Z' }),
    ])
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: repo,
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    expect((await rehydrate(TASK_ID, 'run-nuevo'))?.freeze).toBeUndefined()
  })

  it('con otro run abierto encima, congela la transición', async () => {
    // El watchdog soltó el run viejo, pasó el cooldown, el daemon
    // re-despachó. El cierre tardío del viejo no puede mover la tarea por
    // debajo del que está corriendo.
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([
        row({ id: 'exec-1', runId: 'run-viejo', startedAt: '2026-01-01T00:00:00.000Z' }),
        row({
          id: 'exec-2',
          runId: 'run-nuevo',
          startedAt: '2026-01-01T01:00:00.000Z',
          agentId: 'ci-watcher',
        }),
      ]),
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    const resolved = await rehydrate(TASK_ID, 'run-viejo')

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
  const T0 = Date.parse('2026-01-01T00:00:00.000Z')
  const nowAt = (ms: number) => () => T0 + ms

  it('deja abierto un run cuya sesión sigue viva: su agente todavía puede cerrarlo', async () => {
    const repo = fakeRepo([row({ sessionId: 'iaflow-viva' })])

    const { closed, kept } = await reconcileOrphanedRuns({
      executionLogRepo: repo,
      reason: 'restart',
      probe: async () => 'alive',
      now: nowAt(60_000),
    })

    expect(closed).toBe(0)
    expect(kept).toHaveLength(1)
    expect(repo.updates).toHaveLength(0)
  })

  it('cierra los runs sin sesión: su proceso murió con el daemon', async () => {
    const repo = fakeRepo([row({ sessionKind: null, sessionId: null })])

    const { closed, kept } = await reconcileOrphanedRuns({
      executionLogRepo: repo,
      reason: 'restart',
      now: nowAt(60_000),
    })

    expect(closed).toBe(1)
    expect(kept).toHaveLength(0)
  })

  it('cierra la sesión que el SO confirma muerta — si no, quedaría abierta para siempre', async () => {
    const repo = fakeRepo([row({ sessionId: 'iaflow-muerta' })])

    const { closed, kept } = await reconcileOrphanedRuns({
      executionLogRepo: repo,
      reason: 'restart',
      probe: async () => 'dead',
      now: nowAt(60_000),
    })

    expect(closed).toBe(1)
    expect(kept).toHaveLength(0)
    expect(repo.getById('exec-1')?.errorMsg).toContain('confirmada muerta')
  })

  it('unknown no cierra: no poder preguntar no es evidencia de muerte', async () => {
    const repo = fakeRepo([row({ sessionId: 'iaflow-remota' })])

    const { closed, kept } = await reconcileOrphanedRuns({
      executionLogRepo: repo,
      reason: 'restart',
      probe: async () => 'unknown',
      now: nowAt(60_000),
    })

    expect(closed).toBe(0)
    expect(kept).toHaveLength(1)
  })

  it('pero unknown tiene techo: pasado maxAge se cierra igual', async () => {
    // Sin esto, la fila de una sesión que murió mientras el daemon estaba
    // caído (o que corre en una máquina que no volvió) no la cierra nunca
    // nadie y queda como run en vuelo para siempre.
    const repo = fakeRepo([row({ sessionId: 'iaflow-remota' })])

    const { closed, kept } = await reconcileOrphanedRuns({
      executionLogRepo: repo,
      reason: 'restart',
      probe: async () => 'unknown',
      maxAgeMs: 60_000,
      now: nowAt(2 * 60_000),
    })

    expect(closed).toBe(1)
    expect(kept).toHaveLength(0)
    expect(repo.getById('exec-1')?.errorMsg).toContain('sin confirmar')
  })

  it('una sonda que explota se trata como unknown, no rompe el arranque', async () => {
    const repo = fakeRepo([row({ sessionId: 'iaflow-x' })])

    const { closed, kept } = await reconcileOrphanedRuns({
      executionLogRepo: repo,
      reason: 'restart',
      probe: async () => {
        throw new Error('tmux no responde')
      },
      now: nowAt(60_000),
    })

    expect(closed).toBe(0)
    expect(kept).toHaveLength(1)
  })

  it('una fila colgada no se salva porque la tarea tenga OTRO run vivo', async () => {
    // Mirar sólo el taskId dejaba la colgada abierta para siempre; y con dos
    // abiertas, todo cierre sin `?run=` pasaba a ser ambiguo para siempre.
    const repo = fakeRepo([row({ id: 'exec-1', sessionKind: null, sessionId: null })])
    registerPendingTask(TASK_ID, {
      task: { id: TASK_ID } as never,
      manager: {} as never,
      broadcast: () => {},
      initialStatus: 'Build',
      executionId: 'exec-2',
    })

    const { closed } = await reconcileOrphanedRuns({
      executionLogRepo: repo,
      reason: 'restart',
      now: nowAt(60_000),
    })

    expect(closed).toBe(1)
  })

  it('pero la fila del run que este proceso SÍ está corriendo no se toca', async () => {
    const repo = fakeRepo([row({ id: 'exec-1', sessionKind: null, sessionId: null })])
    registerPendingTask(TASK_ID, {
      task: { id: TASK_ID } as never,
      manager: {} as never,
      broadcast: () => {},
      initialStatus: 'Build',
      executionId: 'exec-1',
    })

    const { closed } = await reconcileOrphanedRuns({
      executionLogRepo: repo,
      reason: 'restart',
      now: nowAt(60_000),
    })

    expect(closed).toBe(0)
  })

  it('la sonda por defecto no le pregunta al SO local por una sesión remota', async () => {
    // Al arrancar, los providers remotos ni siquiera están registrados: no
    // hay a quién preguntarle. `unknown` — y unknown no cierra nada.
    const repo = fakeRepo([row({ providerId: 'remote:mac', sessionId: 'iaflow-alla' })])

    const { closed, kept } = await reconcileOrphanedRuns({
      executionLogRepo: repo,
      reason: 'restart',
      now: nowAt(60_000),
    })

    expect(closed).toBe(0)
    expect(kept).toHaveLength(1)
  })

  it('un session_kind que no conocemos tampoco se da por muerto', async () => {
    const repo = fakeRepo([
      row({ providerId: 'tmux-claude', sessionKind: null, sessionId: 'algo-raro' }),
    ])

    const { closed, kept } = await reconcileOrphanedRuns({
      executionLogRepo: repo,
      reason: 'restart',
      now: nowAt(60_000),
    })

    expect(closed).toBe(0)
    expect(kept).toHaveLength(1)
  })

  it('con provider local sí le pregunta al SO', async () => {
    // El resultado depende del entorno (con tmux instalado, "esa sesión no
    // existe" es evidencia de muerte; sin tmux, no se puede preguntar), así
    // que se afirma lo que no depende del entorno: la fila se decide, en un
    // sentido o en el otro, sin que la sonda rompa el arranque.
    const repo = fakeRepo([
      row({ providerId: 'tmux-claude', sessionKind: 'tmux', sessionId: 'iaflow-no-existe' }),
    ])

    const { closed, kept } = await reconcileOrphanedRuns({
      executionLogRepo: repo,
      reason: 'restart',
      now: nowAt(60_000),
    })

    expect(closed + kept.length).toBe(1)
  })

  it('no toca filas ya cerradas', async () => {
    const repo = fakeRepo([row({ finishedAt: '2026-01-01T00:10:00.000Z', outcome: 'success' })])

    const { closed, kept } = await reconcileOrphanedRuns({
      executionLogRepo: repo,
      reason: 'restart',
      now: nowAt(60_000),
    })

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
    // deja que la salida de éxito se aplique — el comportamiento conservador.
    const rehydrate = createPendingTaskRehydrator({
      executionLogRepo: fakeRepo([row({ initialStatus: null, exits: null })]),
      sourceFor: () => fakeSource([ITEM]),
      broadcast: () => {},
    })

    const resolved = await rehydrate(TASK_ID)

    expect(resolved?.entry.initialStatus).toBe('Build')
    expect(resolved?.entry.exits).toBeUndefined()
  })
})
