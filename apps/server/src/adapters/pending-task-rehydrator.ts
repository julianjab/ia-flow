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
// migración 048 agregó (`initial_status`, `on_finish`/`on_error`, hoy `exits`).
import {
  type PendingTask,
  type PendingTaskRehydrator,
  type ResolvedPendingTask,
  getPendingTask,
} from '@ia-flow/agent-engine'
import type { Liveness } from '@ia-flow/ai-providers'
import { itermLiveness, tmuxLiveness } from '@ia-flow/ai-providers'
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

/** Cuántas filas PROPIAS mirar hacia atrás para una tarea. Suficiente para
 *  ver el run que cierra y el que eventualmente lo dejó atrás, sin traerse el
 *  historial entero de una tarea que pasó diez veces por el pipeline. */
const LOOKBACK = 10

/** Cuántas traer de la DB para quedarse con esas 10. El filtro por `source`
 *  no se puede expresar en la query (el `ownSource` del daemon principal es
 *  NULL, y el filtro de la API no tiene forma de decir "IS NULL"), así que se
 *  filtra en memoria — y si el límite se aplicara antes del filtro, una tarea
 *  con muchas filas reenviadas por otro container podría no dejar ninguna
 *  propia a la vista: el run existiría y el cierre igual rebotaría con "no
 *  hay ejecución", que es el síntoma original. */
const LOOKBACK_FETCH = 100

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
  return async function rehydrate(
    taskId: string,
    runId?: string,
  ): Promise<ResolvedPendingTask | undefined> {
    const rows = deps.executionLogRepo
      .list({ taskId, limit: LOOKBACK_FETCH })
      .filter((r) => (r.source ?? null) === (deps.ownSource ?? null))
      .slice(0, LOOKBACK)
    // `list` viene ordenado por started_at DESC. Se busca PRIMERO la fila del
    // run que está cerrando (el `?run=` de su conexión MCP): tomar la más
    // nueva a ciegas hace que el cierre tardío de una sesión vieja aterrice
    // sobre la ejecución de otro run — y al cerrarla, el cierre real de ESE
    // run se descarta después como duplicado. Es el mismo agujero que este
    // archivo viene a tapar, una vuelta más adentro.
    const matched = runId ? rows.find((r) => r.runId === runId) : undefined
    // Sin `?run=`, el candidato sale de las ABIERTAS. Mirar `rows[0]` a secas
    // elige la más nueva aunque ya esté cerrada, y entonces un cierre se
    // aplicaría con la salida de éxito de un run terminado mientras el que de
    // verdad está trabajando queda sin cerrar — y su cierre real, descartado
    // después como duplicado.
    const open = rows.filter((r) => r.finishedAt == null)
    const candidates = open.length > 0 ? open : rows
    const row = matched ?? candidates[0]
    if (!row) return undefined

    // Guarda "gana el run más nuevo": si el que cierra es viejo y hay otro
    // abierto ARRANCADO DESPUÉS, se acepta el cierre pero no se mueve la
    // tarea. Pasa de verdad: el watchdog suelta un run por error, pasa el
    // cooldown, el daemon re-despacha, y la sesión vieja —que seguía viva—
    // llega con su `complete_task` cuando ya hay otro agente trabajando el
    // mismo issue.
    const openNewer = open.find((r) => r.id !== row.id && r.startedAt > row.startedAt)

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
        exits: row.exits ?? undefined,
        broadcast: deps.broadcast,
        // Sin la columna (filas previas a la migración 048), el status de
        // ahora es lo mejor que tenemos: equivale a "nadie lo movió", que es
        // el comportamiento conservador — deja que la salida de éxito se aplique.
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

      // ¿Sabemos con certeza a qué ejecución pertenece este cierre? Sólo en
      // dos casos: el run se identificó (`?run=`), o hay una sola abierta y
      // nadie más con quien confundirla. Todo lo demás —un `runId` que no
      // matchea ninguna fila, o ningún `runId` con varias abiertas— es una
      // apuesta, y la apuesta que perdés marca como terminado un run que
      // sigue trabajando: su cierre real se descarta después como duplicado,
      // sin comentario y sin transición. Ante la duda no se cierra ni se
      // transiciona ninguna; la fila la resuelve la reconciliación de
      // arranque.
      const ambiguous = matched == null && (runId != null || candidates.length > 1)

      return {
        entry,
        alreadyClosed: closedByTool(row),
        // El orquestador de este run se fue con el proceso anterior: si no
        // cierra la fila el propio tool, no la cierra nadie.
        finalize: ambiguous
          ? undefined
          : (outcome) =>
              deps.executionLogRepo.update(row.id, {
                finishedAt: new Date().toISOString(),
                outcome,
                finalizedByTool: true,
              }),
        freeze: ambiguous
          ? 'no se pudo identificar a qué ejecución pertenece este cierre'
          : openNewer
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
 * Tres casos, en orden:
 *
 *  1. **Sin sesión** (runs sync, cuyo proceso murió con el daemon) → cerrar,
 *     como antes.
 *  2. **Con sesión que se puede sondear y está muerta** → cerrar. Sondear es
 *     lo que evita el otro extremo: dejar abierta para siempre la fila de una
 *     sesión que murió mientras el daemon estaba caído.
 *  3. **Con sesión viva, o que no se puede sondear** → dejar abierta, con un
 *     techo (`maxAgeMs`). Una sesión de otra máquina no se puede sondear
 *     desde acá al arrancar (los providers remotos todavía no están
 *     registrados), y sin el techo una fila así no la cerraría nunca nadie.
 */
export async function reconcileOrphanedRuns(deps: {
  executionLogRepo: IExecutionLogRepository
  reason: string
  /** Sonda de liveness. Default: las sesiones locales (tmux/iTerm), que son
   *  las únicas que este proceso puede mirar sin ayuda. Devolver `unknown`
   *  significa "no sé", y eso NO cierra el run — misma regla que el
   *  watchdog: la muerte necesita evidencia positiva. */
  probe?: (row: ExecutionLog) => Promise<Liveness>
  /** Cuánto se tolera una fila abierta que no se pudo confirmar. Default 24h:
   *  largo comparado con cualquier run real, corto comparado con "para
   *  siempre". */
  maxAgeMs?: number
  now?: () => number
}): Promise<{ closed: number; kept: ExecutionLog[] }> {
  const probe = deps.probe ?? localSessionLiveness
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE_MS
  const now = deps.now?.() ?? Date.now()
  const active = deps.executionLogRepo.listActive()
  const kept: ExecutionLog[] = []
  let closed = 0

  const close = (row: ExecutionLog, reason: string): void => {
    deps.executionLogRepo.update(row.id, {
      finishedAt: new Date(now).toISOString(),
      outcome: 'cancelled',
      errorMsg: reason,
    })
    closed += 1
  }

  for (const row of active) {
    // Ya lo corre este proceso (arranque en caliente): no es huérfano. Se
    // compara por EJECUCIÓN y no por tarea: una tarea puede tener una fila
    // viva y otra colgada de un proceso anterior, y mirar sólo el taskId
    // dejaría la colgada abierta para siempre — y con dos abiertas, todo
    // cierre sin `?run=` pasaría a ser ambiguo de forma permanente.
    if (getPendingTask(row.taskId)?.executionId === row.id) continue
    if (!row.sessionId) {
      close(row, deps.reason)
      continue
    }
    const liveness = await probe(row).catch(() => 'unknown' as Liveness)
    if (liveness === 'dead') {
      close(row, `${deps.reason} (sesión confirmada muerta)`)
      continue
    }
    const ageMs = now - Date.parse(row.startedAt)
    if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
      close(row, `${deps.reason} (sesión sin confirmar tras ${Math.round(ageMs / 3_600_000)}h)`)
      continue
    }
    kept.push(row)
  }
  return { closed, kept }
}

/** 24h. Un run real no dura eso; una fila abierta para siempre, sí. */
const DEFAULT_ORPHAN_MAX_AGE_MS = 24 * 60 * 60_000

/**
 * Liveness de una sesión mirando el SO de ESTA máquina.
 *
 * Sólo sirve para los providers locales. Una sesión que corre en un gateway
 * remoto se reporta `unknown` a propósito: al arrancar, los providers remotos
 * ni siquiera están registrados todavía (los da de alta la primera ronda del
 * health monitor), así que no hay a quién preguntarle — y `unknown` no cierra
 * nada, que es la respuesta correcta cuando no se sabe.
 */
async function localSessionLiveness(row: ExecutionLog): Promise<Liveness> {
  if (!row.sessionId || row.providerId.startsWith('remote:')) return 'unknown'
  if (row.sessionKind === 'tmux') return tmuxLiveness(row.sessionId)
  if (row.sessionKind === 'iterm') return itermLiveness(row.sessionId)
  return 'unknown'
}
