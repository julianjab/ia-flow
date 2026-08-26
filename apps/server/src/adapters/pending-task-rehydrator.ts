// Reconstruye un run en vuelo desde `execution_logs` cuando el registry en
// memoria ya no lo tiene.
//
// El incidente que lo motivó: un agente async (tmux, en un gateway de otra
// máquina) trabajó una hora, pusheó dos commits y abrió un PR — y cuando
// llamó a `complete_task`, el daemon había reiniciado y su entrada pendiente
// vivía sólo en un `Map` del proceso viejo. El agente recibió "No pending
// task", concluyó cualquier cosa, y el issue quedó sin comentario, sin
// transición y sin nadie que lo retomara.
//
// La sesión del agente vive en el SO de otra máquina y no le importa que este
// proceso reinicie. Así que el `Map` pasa a ser un cache y la fuente de
// verdad es la fila de `execution_logs`, que ya tiene todo salvo lo que la
// migración 048 agregó (`initial_status`, `on_finish`, `on_error`).
import {
  type PendingTask,
  type PendingTaskRehydrator,
  type ResolvedPendingTask,
  getPendingTask,
} from '@ia-flow/agent-engine'
import { type ProjectSource, defaultToIssueItem, issueItemToTask } from '@ia-flow/issue-sources'
import type { ExecutionLog } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../domain/ports/IExecutionLogRepository.js'
import { createLogger } from '../logger.js'

const log = createLogger('pending-task-rehydrator')

export interface RehydratorDeps {
  executionLogRepo: IExecutionLogRepository
  /** Source del proyecto — el que sabe leer el issue y construir el
   *  `TaskSource` que aplica transiciones. */
  sourceFor: (projectId: string) => ProjectSource
  broadcast: (msg: object) => void
  /** Sólo se rehidratan runs de ESTE proceso. Una fila reenviada por otro
   *  container (`source` != el propio) la cierra su dueño; tocarla desde acá
   *  sería aplicar una transición por un run que no controlamos. */
  ownSource?: string | null
}

/** Cuántas filas mirar hacia atrás para una tarea. Suficiente para ver el run
 *  que cierra y el que eventualmente lo dejó atrás, sin traerse el historial
 *  entero de una tarea que pasó diez veces por el pipeline. */
const LOOKBACK = 10

/** Un run cerrado por un tool ya publicó su comentario y aplicó su
 *  transición: volver a cerrarlo sería duplicar. Los demás cierres
 *  (cancelado, huérfano por un reinicio, error de infra) NO son un cierre del
 *  agente — si el agente aparece ahora con su resultado, se acepta.
 *
 *  Se mira la columna explícita y no `outcome`: la barrida de huérfanos
 *  también escribe `outcome: 'error'`, así que confundirlas descartaría como
 *  duplicado justo el cierre que este archivo existe para permitir. */
function closedByTool(row: ExecutionLog): boolean {
  return row.finalizedByTool === true
}

export function createPendingTaskRehydrator(deps: RehydratorDeps): PendingTaskRehydrator {
  return async function rehydrate(taskId: string): Promise<ResolvedPendingTask | undefined> {
    const rows = deps.executionLogRepo
      .list({ taskId, limit: LOOKBACK })
      .filter((r) => (r.source ?? null) === (deps.ownSource ?? null))
    // `list` viene ordenado por started_at DESC.
    const row = rows[0]
    if (!row) return undefined

    // Guarda "gana el run más nuevo": si el que quiere cerrar es viejo y hay
    // otro abierto encima, se acepta el cierre pero no se mueve la tarea.
    // Pasa de verdad: el watchdog suelta un run por error, pasa el cooldown,
    // el daemon re-despacha, y la sesión vieja —que seguía viva— llega con su
    // `complete_task` cuando ya hay otro agente trabajando el mismo issue.
    const openNewer = rows.find((r) => r.finishedAt == null && r.id !== row.id)

    const project = row.projectId
    if (!project) {
      log.warn({ taskId, executionId: row.id }, 'Ejecución sin projectId — no se puede rehidratar')
      return undefined
    }

    try {
      const source = deps.sourceFor(project)
      if (!source.getTransitionManager) {
        log.warn({ taskId, kind: source.kind }, 'El source no aplica transiciones — sin rehidratar')
        return undefined
      }
      // Sin `refresh: true` a propósito: el daemon poletea el source de
      // continuo, así que su cache está al día, y forzar un refetch acá
      // pondría una llamada a la API por cada tool call de un agente con un
      // task_id que no resuelve. El estado que sí tiene que ser fresco —el
      // status contra el que se decide si transicionar— lo relee
      // `complete_task` con `getCurrentStatus` sobre el manager.
      const items = await source.getItems()
      const raw = items.find((i) => i.id === taskId)
      if (!raw) {
        log.warn(
          { taskId, projectId: project },
          'El issue ya no está en el source — sin rehidratar',
        )
        return undefined
      }
      // Mismo mapeo que usa el daemon en su scan (SourceDispatcher): el
      // `TaskSource` de cada source necesita el `meta` que su propio
      // `toIssueItem` guarda, no el SourceItem pelado que devuelve `getItems`.
      const item = source.toIssueItem ? source.toIssueItem(raw) : defaultToIssueItem(raw)

      const manager = source.getTransitionManager(item, deps.broadcast)
      const task = issueItemToTask(item)
      const entry: PendingTask = {
        task,
        manager,
        onFinish: row.onFinish ?? undefined,
        onError: row.onError ?? undefined,
        broadcast: deps.broadcast,
        // Sin la columna (filas previas a la migración 048), el status de
        // ahora es lo mejor que tenemos: equivale a "nadie lo movió", que es
        // el comportamiento conservador — deja que el onFinish se aplique.
        initialStatus: row.initialStatus ?? task.status,
        reconciliationStatus: row.initialStatus ?? task.status,
        runId: row.runId ?? undefined,
        agentId: row.agentId,
        agentName: row.agentId,
        providerId: row.providerId,
        projectId: project,
        executionId: row.id,
      }

      log.info(
        {
          taskId,
          executionId: row.id,
          agent: row.agentId,
          closed: row.finishedAt != null,
          outcome: row.outcome,
        },
        'Run rehidratado desde execution_logs — el registry en memoria no lo tenía',
      )

      return {
        entry,
        alreadyClosed: closedByTool(row),
        // El orquestador de este run se fue con el proceso anterior: si no
        // cierra la fila el propio tool, no la cierra nadie.
        finalize: (outcome) =>
          deps.executionLogRepo.update(row.id, {
            finishedAt: new Date().toISOString(),
            outcome,
            finalizedByTool: true,
          }),
        freeze: openNewer
          ? `hay otro run abierto sobre esta tarea (${openNewer.agentId}, ${openNewer.id})`
          : undefined,
      }
    } catch (err) {
      log.warn({ taskId, err }, 'No se pudo rehidratar el run')
      return undefined
    }
  }
}

/**
 * Cierra en `execution_logs` los runs que quedaron abiertos de un proceso
 * anterior, PERO sólo los que de verdad ya no pueden avanzar.
 *
 * Reemplaza la barrida ciega del arranque (`sweepOrphaned`), que cerraba todo
 * lo que tuviera `finished_at IS NULL` apoyada en que "las filas en vuelo
 * sólo existen mientras el proceso vive". Eso es falso justo para los runs
 * que más importan: una sesión de tmux o una tab de iTerm sobreviven al
 * reinicio del daemon, y su agente sigue trabajando. Cerrarles la fila los
 * dejaba sin forma de cerrarse después.
 *
 * Criterio: un run con sesión async registrada se deja ABIERTO — su agente
 * puede aparecer en cualquier momento con `complete_task`, y ahora el
 * rehidratador se lo va a poder aplicar. Todo lo demás (runs sync, cuyo
 * proceso murió con el daemon) se cierra como antes.
 */
export function reconcileOrphanedRuns(deps: {
  executionLogRepo: IExecutionLogRepository
  reason: string
}): { closed: number; kept: ExecutionLog[] } {
  const active = deps.executionLogRepo.listActive()
  const kept: ExecutionLog[] = []
  let closed = 0
  for (const row of active) {
    // Ya lo tiene este proceso (arranque en caliente): no es huérfano.
    if (getPendingTask(row.taskId)) continue
    if (row.sessionId) {
      kept.push(row)
      continue
    }
    deps.executionLogRepo.update(row.id, {
      finishedAt: new Date().toISOString(),
      outcome: 'cancelled',
      errorMsg: deps.reason,
    })
    closed += 1
  }
  return { closed, kept }
}
