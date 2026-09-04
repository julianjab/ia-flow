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
// **`agentId` guarda el NOMBRE de la acción**, cuando la regla la corrió por
// `ref`. Es la columna que el listado ya muestra en esa posición, y una acción
// con nombre es exactamente lo que el operador busca ahí; una inline no tiene
// nombre y queda vacía — la identifica su regla más su posición.
//
// **`''` en las columnas de agente** (`agentId`, `providerId`, y
// `taskId`/`taskTitle` cuando el evento no trae issue): son NOT NULL desde la
// migración 001 y sacarles la restricción obliga a reconstruir la tabla. Ver
// `ExecutionLogSchema`.
export class ExecutionActionRecorder implements ActionRunRecorder {
  /** Cuándo arrancó cada acción en vuelo, para poder loguear su duración. Se
   *  borra al cerrar: una acción que nunca cierra es un bug del runner, no algo
   *  que este mapa deba sobrevivir. */
  private readonly startedAt = new Map<string, number>()

  constructor(private readonly repo: IExecutionLogRepository) {}

  async onActionStart(
    info: Parameters<NonNullable<ActionRunRecorder['onActionStart']>>[0],
  ): Promise<string | undefined> {
    if (info.kind === 'agent') return undefined

    const { rule, event, position, kind, name } = info
    // Determinístico, así que un reintento del MISMO evento sobre la MISMA
    // acción pisa su fila en vez de sembrar duplicados (el insert es un upsert
    // por id).
    //
    // **La regla va en la clave.** `position` es el índice dentro del `do[]` de
    // CADA regla, y un evento puede matchear varias: dos reglas con una acción
    // en posición 0 colisionarían, y el upsert le pisaría la fila a la primera
    // —incluido su `onActionEnd`, que terminaría cerrando la fila ajena—.
    const id = `${event.id}:${rule.id}:${position}`
    const entry: ExecutionLog = {
      id,
      projectId: event.scope.projectId ?? '',
      taskId: event.scope.issueId ?? '',
      taskTitle: taskTitleOf(event),
      agentId: name ?? '',
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
      traceId: event.traceId ?? null,
    }
    this.startedAt.set(id, Date.now())
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
    if (info.kind === 'agent') return
    const { result, error } = info
    // `deferred` no es un fallo: es "hay trabajo, no hay capacidad". Se
    // registra como su propio outcome para que el listado no lo muestre en
    // rojo al lado de una llamada HTTP que de verdad se cayó.
    // Ni `deferred` ni `skipped` son fallos: el primero es "hay trabajo, no hay
    // capacidad" y el segundo "no había nada que hacer". Mostrarlos en rojo al
    // lado de una llamada HTTP que de verdad se cayó haría el listado inútil
    // justo cuando hay algo roto de verdad.
    const outcome: ExecutionLog['outcome'] = error
      ? 'error'
      : result.deferred || result.skipped
        ? 'cancelled'
        : result.ok
          ? 'success'
          : 'error'
    const detail = error ? String((error as Error)?.message ?? error) : (result.detail ?? null)

    // El cierre TAMBIÉN va al log, no sólo a SQLite. Los handlers loguean que
    // arrancan (el script con su path, el http con su url) y ninguno que
    // terminó: en el detalle de una acción se veía "Corriendo script" y nada
    // más, sin forma de saber si salió bien. `ruleId` va sí o sí — es lo único
    // que correlaciona las líneas de una acción, que no tiene `runId`.
    const started = info.runId ? this.startedAt.get(info.runId) : undefined
    if (info.runId) this.startedAt.delete(info.runId)
    const line = {
      ruleId: info.rule.id,
      eventId: info.event.id,
      kind: info.kind,
      position: info.position,
      outcome,
      detail,
      ...(started !== undefined ? { durationMs: Date.now() - started } : {}),
    }
    // Un `deferred` no es un fallo —es "hay trabajo, no hay capacidad"— y se
    // reintenta solo: en warn sería ruido en cada ciclo con el pipeline lleno.
    if (outcome === 'error') log.warn(line, 'Acción terminada con error')
    else log.info(line, 'Acción terminada')

    if (!info.runId) return
    try {
      this.repo.update(info.runId, {
        finishedAt: new Date().toISOString(),
        outcome,
        errorMsg: detail,
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
