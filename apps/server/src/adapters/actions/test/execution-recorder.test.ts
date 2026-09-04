import { describe, expect, test } from 'bun:test'
import type { EngineEvent, ExecutionLog, Rule } from '@ia-flow/shared'
import { createEvent } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../../../domain/ports/IExecutionLogRepository.js'
import { setLogBroadcast } from '../../../logger.js'
import { ExecutionActionRecorder } from '../execution-recorder.js'

/** Engancha el sink de broadcast del logger —el mismo por el que las líneas
 *  llegan a la UI en vivo— para leer lo que el recorder loguea sin mockear el
 *  módulo entero. Devuelve cómo desengancharlo. */
function captureLogs(into: Array<{ level: string; data: Record<string, unknown> }>): () => void {
  setLogBroadcast((msg) => {
    const entry = (msg as { entry?: { level: string; extras?: Record<string, unknown> } }).entry
    if (entry) into.push({ level: entry.level, data: entry.extras ?? {} })
  })
  return () => setLogBroadcast(() => {})
}

// Un repo falso escrito a mano: lo que importa de esta clase es QUÉ fila
// escribe, no cómo se guarda.
function fakeRepo(over: Partial<IExecutionLogRepository> = {}) {
  const inserted: ExecutionLog[] = []
  const updated: Array<{ id: string; patch: Partial<ExecutionLog> }> = []
  const repo = {
    insert: (entry: ExecutionLog) => {
      inserted.push(entry)
    },
    update: (id: string, patch: Partial<ExecutionLog>) => {
      updated.push({ id, patch })
    },
    list: () => [],
    listActive: () => [],
    getById: () => null,
    sweepOrphaned: () => [],
    listDistinctSources: () => [],
    listLastOutputsByAgent: () => [],
    ...over,
  } as IExecutionLogRepository
  return { repo, inserted, updated }
}

const rule = { id: 'r1', on: ['issue.scanned'], do: [] } as unknown as Rule

function event(over: Partial<Parameters<typeof createEvent>[0]> = {}): EngineEvent {
  return createEvent({
    type: 'issue.scanned',
    source: 'engine',
    scope: { projectId: 'p1', issueId: 'i1' },
    payload: { title: 'Arreglar el login' },
    ...over,
  } as Parameters<typeof createEvent>[0])
}

describe('ExecutionActionRecorder', () => {
  test('guarda el nombre de la acción en la columna del agente', async () => {
    const { repo, inserted } = fakeRepo()

    await new ExecutionActionRecorder(repo).onActionStart({
      rule,
      event: event(),
      position: 0,
      kind: 'http',
      name: 'Avisar en Slack',
    })

    // Es la columna que el listado muestra ahí, y una acción con nombre es
    // justo lo que el operador busca en esa posición.
    expect(inserted[0].agentId).toBe('Avisar en Slack')
  })

  test('una acción inline no inventa nombre', async () => {
    const { repo, inserted } = fakeRepo()

    await new ExecutionActionRecorder(repo).onActionStart({
      rule,
      event: event(),
      position: 0,
      kind: 'http',
    })

    // `agentId` es NOT NULL desde la migración 001: la fila queda con `''` y
    // la identifica su regla más su posición.
    expect(inserted[0].agentId).toBe('')
  })

  test('escribe una fila por acción, con la regla y el evento que la causaron', async () => {
    const { repo, inserted } = fakeRepo()
    const ev = event()

    const id = await new ExecutionActionRecorder(repo).onActionStart({
      rule,
      event: ev,
      position: 0,
      kind: 'script',
    })

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      id,
      kind: 'script',
      ruleId: 'r1',
      eventId: ev.id,
      eventType: 'issue.scanned',
      position: 0,
      projectId: 'p1',
      taskId: 'i1',
      taskTitle: 'Arreglar el login',
      finishedAt: null,
      outcome: null,
    })
  })

  // El run del agente escribe su PROPIA fila, con su telemetría y su runId.
  // Registrarla acá también daría dos filas para una sola cosa.
  test('la acción `agent` no genera fila: la escribe el run', async () => {
    const { repo, inserted } = fakeRepo()

    const id = await new ExecutionActionRecorder(repo).onActionStart({
      rule,
      event: event(),
      position: 1,
      kind: 'agent',
    })

    expect(id).toBeUndefined()
    expect(inserted).toHaveLength(0)
  })

  test('el id es determinístico — un reintento de la misma acción pisa su fila', async () => {
    const { repo } = fakeRepo()
    const recorder = new ExecutionActionRecorder(repo)
    const ev = event()

    const first = await recorder.onActionStart({ rule, event: ev, position: 2, kind: 'http' })
    const again = await recorder.onActionStart({ rule, event: ev, position: 2, kind: 'http' })

    expect(first).toBe(again as string)
  })

  // `position` es el índice dentro del `do[]` de CADA regla, y un evento puede
  // matchear varias: sin la regla en la clave, la segunda le pisaba la fila a
  // la primera y encima su cierre terminaba escribiendo sobre la ajena.
  test('dos reglas sobre el mismo evento no comparten id', async () => {
    const { repo, inserted } = fakeRepo()
    const recorder = new ExecutionActionRecorder(repo)
    const ev = event()
    const otra = { ...rule, id: 'r2' } as typeof rule

    const a = await recorder.onActionStart({ rule, event: ev, position: 0, kind: 'http' })
    const b = await recorder.onActionStart({ rule: otra, event: ev, position: 0, kind: 'http' })

    expect(a).not.toBe(b as string)
    expect(inserted.map((e) => e.ruleId)).toEqual(['r1', 'r2'])
  })

  test('cierra la fila con success y el detalle de la acción', async () => {
    const { repo, updated } = fakeRepo()
    const recorder = new ExecutionActionRecorder(repo)

    await recorder.onActionEnd({
      runId: 'e1:0',
      rule,
      event: event(),
      position: 0,
      kind: 'http',
      result: { ok: true, detail: '200 OK' },
    })

    expect(updated[0].id).toBe('e1:0')
    expect(updated[0].patch).toMatchObject({ outcome: 'success', errorMsg: '200 OK' })
    expect(updated[0].patch.finishedAt).toBeTruthy()
  })

  test('un throw de la acción se registra como error, con su mensaje', async () => {
    const { repo, updated } = fakeRepo()

    await new ExecutionActionRecorder(repo).onActionEnd({
      runId: 'e1:0',
      rule,
      event: event(),
      position: 0,
      kind: 'script',
      result: { ok: false },
      error: new Error('exit 1'),
    })

    expect(updated[0].patch).toMatchObject({ outcome: 'error', errorMsg: 'exit 1' })
  })

  // `deferred` es "hay trabajo, no hay capacidad": pintarlo igual que una
  // llamada HTTP caída haría que el listado mienta sobre la salud del pipeline.
  test('un deferred no se registra como error', async () => {
    const { repo, updated } = fakeRepo()

    await new ExecutionActionRecorder(repo).onActionEnd({
      runId: 'e1:0',
      rule,
      event: event(),
      position: 0,
      // Un `agent` no llega acá —no tiene fila propia que cerrar—, así que el
      // caso real de un deferred es la acción que lo despacha.
      kind: 'agent-dispatch',
      result: { ok: false, deferred: true, detail: 'sin capacidad' },
    })

    expect(updated[0].patch.outcome).toBe('cancelled')
  })

  test('sin runId no toca nada: el inicio no se pudo registrar', async () => {
    const { repo, updated } = fakeRepo()

    await new ExecutionActionRecorder(repo).onActionEnd({
      rule,
      event: event(),
      position: 0,
      kind: 'http',
      result: { ok: true },
    })

    expect(updated).toHaveLength(0)
  })

  // Registrar es observabilidad: que falle no puede tumbar la acción que el
  // operador realmente pidió.
  test('un repo que tira no rompe la acción', async () => {
    const { repo } = fakeRepo({
      insert: () => {
        throw new Error('db caída')
      },
    })

    const id = await new ExecutionActionRecorder(repo).onActionStart({
      rule,
      event: event(),
      position: 0,
      kind: 'http',
    })

    expect(id).toBeUndefined()
  })

  test('sin issue en el scope, el título es el tipo de evento', async () => {
    const { repo, inserted } = fakeRepo()

    await new ExecutionActionRecorder(repo).onActionStart({
      rule,
      event: event({ type: 'slack.message', source: 'slack', scope: {}, payload: {} }),
      position: 0,
      kind: 'http',
    })

    expect(inserted[0]).toMatchObject({ taskId: '', taskTitle: 'slack.message', projectId: '' })
  })
})

// El detalle de una acción mostraba "Corriendo script" y nada más: los handlers
// loguean que arrancan y ninguno que terminó, así que no había forma de saber si
// salió bien.
describe('ExecutionActionRecorder — el cierre también se loguea', () => {
  test('loguea el fin con la regla, el outcome y el detalle', async () => {
    const { repo } = fakeRepo()
    const lines: Array<{ level: string; data: Record<string, unknown> }> = []
    const recorder = new ExecutionActionRecorder(repo)
    const restore = captureLogs(lines)

    try {
      await recorder.onActionEnd({
        runId: 'ev-1:r1:0',
        rule,
        event: event(),
        position: 0,
        kind: 'script',
        result: { ok: true, detail: 'exit 0' },
      })
    } finally {
      restore()
    }

    expect(lines).toHaveLength(1)
    expect(lines[0].level).toBe('info')
    // `ruleId` sí o sí: es lo único que correlaciona las líneas de una acción,
    // que no tiene `runId` que estampar.
    expect(lines[0].data).toMatchObject({
      ruleId: 'r1',
      kind: 'script',
      position: 0,
      outcome: 'success',
      detail: 'exit 0',
    })
  })

  test('un error va en warn; un deferred no', async () => {
    const { repo } = fakeRepo()
    const lines: Array<{ level: string; data: Record<string, unknown> }> = []
    const recorder = new ExecutionActionRecorder(repo)
    const restore = captureLogs(lines)

    try {
      await recorder.onActionEnd({
        runId: 'a',
        rule,
        event: event(),
        position: 0,
        kind: 'http',
        result: { ok: false },
        error: new Error('ECONNREFUSED'),
      })
      // "Hay trabajo, no hay capacidad" se reintenta solo: en warn sería ruido
      // en cada ciclo con el pipeline lleno.
      await recorder.onActionEnd({
        runId: 'b',
        rule,
        event: event(),
        position: 1,
        kind: 'agent-dispatch',
        result: { ok: false, deferred: true },
      })
    } finally {
      restore()
    }

    expect(lines.map((l) => l.level)).toEqual(['warn', 'info'])
    expect(lines[0].data.detail).toBe('ECONNREFUSED')
  })

  test('un run de agente no deja línea: cierra su propia fila', async () => {
    const { repo } = fakeRepo()
    const lines: Array<{ level: string; data: Record<string, unknown> }> = []
    const restore = captureLogs(lines)

    try {
      await new ExecutionActionRecorder(repo).onActionEnd({
        rule,
        event: event(),
        position: 0,
        kind: 'agent',
        result: { ok: true },
      })
    } finally {
      restore()
    }

    expect(lines).toHaveLength(0)
  })
})
