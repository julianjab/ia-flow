import type { ActionRunRecorder } from '@ia-flow/rules'
import type { ExecutionLog } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../../domain/ports/IExecutionLogRepository.js'
import { createLogger } from '../../logger.js'

const log = createLogger('action-recorder')

// Cada acción que una regla ejecuta deja su fila en `execution_logs`, al lado
// del run del agente que corrió en la misma secuencia.
//
// Es la implementación del `ActionRunRecorder` que `runRule` declaraba desde la
// migración 058 y que nadie cableaba — por eso `action_runs` quedó vacía y una
// acción `http` o `script` sólo existía en una línea de log que rota.
//
// **La acción `agent` se saltea a propósito.** Su fila la escribe el propio
// run (`Agent.run` → `safeInsertLog`) con sus 30 columnas de telemetría, su
// `runId` y su ciclo de vida. Registrarla también acá daría dos filas para una
// sola cosa, y la de acá sería la peor de las dos. El vínculo con la regla no
// se pierde: el run recibe `ruleId`/`eventId` por el mismo camino y los guarda
// en su propia fila.
//
// **`''` en las columnas de agente** (`agentId`, `providerId`, y
// `taskId`/`taskTitle` cuando el evento no trae issue): son NOT NULL desde la
// migración 001 y sacarles la restricción obliga a reconstruir la tabla. Ver
// `ExecutionLogSchema`.
export class ExecutionActionRecorder implements ActionRunRecorder {
  constructor(private readonly repo: IExecutionLogRepository) {}

  async onActionStart(
    info: Parameters<NonNullable<ActionRunRecorder['onActionStart']>>[0],
  ): Promise<string | undefined> {
    if (info.kind === 'agent') return undefined

    const { rule, event, position, kind } = info
    // El id lleva el evento y la posición: es determinístico, así que un
    // reintento del MISMO evento sobre la MISMA posición pisa su fila en vez
    // de sembrar duplicados (el insert es un upsert por id).
    const id = `${event.id}:${position}`
    const entry: ExecutionLog = {
      id,
      projectId: event.scope.projectId ?? '',
      taskId: event.scope.issueId ?? '',
      taskTitle: taskTitleOf(event),
      agentId: '',
      providerId: '',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outcome: null,
      errorMsg: null,
      stopReason: null,
      kind,
      ruleId: rule.id,
      eventId: event.id,
      eventType: event.type,
      position,
    }
    try {
      this.repo.insert(entry)
    } catch (err) {
      // Registrar es observabilidad: que falle no puede impedir que la acción
      // corra, que es lo que el operador realmente pidió.
      log.warn({ err, ruleId: rule.id, kind }, 'No se pudo registrar el inicio de la acción')
      return undefined
    }
    return id
  }

  async onActionEnd(
    info: Parameters<NonNullable<ActionRunRecorder['onActionEnd']>>[0],
  ): Promise<void> {
    if (!info.runId) return
    const { result, error } = info
    // `deferred` no es un fallo: es "hay trabajo, no hay capacidad". Se
    // registra como su propio outcome para que el listado no lo muestre en
    // rojo al lado de una llamada HTTP que de verdad se cayó.
    const outcome: ExecutionLog['outcome'] = error
      ? 'error'
      : result.deferred
        ? 'cancelled'
        : result.ok
          ? 'success'
          : 'error'
    try {
      this.repo.update(info.runId, {
        finishedAt: new Date().toISOString(),
        outcome,
        errorMsg: error ? String((error as Error)?.message ?? error) : (result.detail ?? null),
      })
    } catch (err) {
      log.warn({ err, id: info.runId }, 'No se pudo registrar el fin de la acción')
    }
  }
}

/** El título que la fila muestra. El issue cuando lo hay; si no, el evento —
 *  una acción sobre un `slack.message` no tiene tarea y "" no dice nada. */
function taskTitleOf(event: { type: string; payload: Record<string, unknown> }): string {
  const title = event.payload.title
  return typeof title === 'string' && title.trim() ? title : event.type
}
