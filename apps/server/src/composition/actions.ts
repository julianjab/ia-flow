import {
  type AgentRunState,
  type DispatchOptions,
  getPendingTask,
  listPendingTasks,
  MAX_RESUME_AGE_MS,
  MAX_RESUME_ATTEMPTS,
} from '@ia-flow/agent-engine'
import type { IIssueManager, IssueItem, SourceItem } from '@ia-flow/issue-sources'
// Registro de las acciones que este daemon sabe ejecutar.
//
// Vive en `composition/` y no en el container mismo porque es cableado con
// forma de side effect (`registerAction` puebla un Map del paquete `rules`), y
// mezclarlo con las definiciones de repositorios haría más difícil ver qué se
// registra. Lo importa el arranque, una vez.
import { registerAction } from '@ia-flow/rules'
import type { RecoverableCheckpoint } from '@ia-flow/shared'
import { AgentAction } from '../adapters/actions/agent-action.js'
import { createCheckpointSweep } from '../adapters/actions/checkpoint-sweep.js'
import { EmitAction } from '../adapters/actions/emit-action.js'
import { HttpAction } from '../adapters/actions/http-action.js'
import { createRedispatchAborted } from '../adapters/actions/redispatch-aborted.js'
import { createResolveEventItem } from '../adapters/actions/resolve-event-item.js'
import { createResolveRuleConversation } from '../adapters/actions/resolve-rule-conversation.js'
import { ScriptAction } from '../adapters/actions/script-action.js'
import type { AgentAbortRecord } from '../domain/ports/IAgentAbortRepository.js'
import type { RunCheckpoint } from '../domain/ports/IRunCheckpointRepository.js'
import { createLogger } from '../logger.js'
import { CHAT_PROJECT_ID } from '../system-agents/index.js'
import {
  agentAbortRepo,
  chatIssueManager,
  dispatcher,
  executionLogRepo,
  getSourceForProjectId,
  interpolateSecrets,
  repoRepo,
  runCheckpointRepo,
  runTaskNowUseCase,
} from './container.js'

const log = createLogger('composition:actions')

/** Los managers vivos, indexados por proyecto. Los publica `daemon.ts` en cada
 *  `startAll`/`reloadManagers`, porque su ciclo de vida es el del daemon y no
 *  el del container. */
const managers = new Map<string, IIssueManager>()

export function setActiveManagers(next: readonly IIssueManager[]): void {
  managers.clear()
  for (const m of next) managers.set(m.projectId, m)
}

/** Lookup del manager vivo de un proyecto — la misma tabla que usa `AgentAction`
 *  para despachar, expuesta para que otro consumidor (el gate `whenText` de
 *  `daemon.ts`) no tenga que mantener su propio índice.
 *
 * `CHAT_PROJECT_ID` es un caso especial a propósito: el asistente conversacional
 * NO es un proyecto (ver `apps/server/src/system-agents/`) — su manager no sale
 * de `buildManagers()`/`projectRepo.list()` como el resto, así que nunca está en
 * el mapa `managers`. Se resuelve acá, a mano, antes de consultarlo. */
export function managerFor(projectId: string): IIssueManager | undefined {
  if (projectId === CHAT_PROJECT_ID) return chatIssueManager
  return managers.get(projectId)
}

/** De un scope de evento al issue del board — instancia única para que
 *  `AgentAction` y el gate `whenText` de `daemon.ts` resuelvan exactamente
 *  igual, sin duplicar el `sourceFor` que cablea. */
export const resolveEventItem = createResolveEventItem({ sourceFor: getSourceForProjectId })

/** La conversación que el gate `whenText` de una regla todavía no vio — ver
 *  `resolve-rule-conversation.ts` para el porqué de la I/O acá. */
export const resolveRuleConversation = createResolveRuleConversation({
  managerFor,
  resolveItem: resolveEventItem,
})

/** Vuelve a correr el agente de un `AgentAbortRecord` — usado tanto por el
 *  barrido automático de `daemon.ts` como por el botón manual de
 *  `routes/agent-aborts.ts`. */
export const redispatchAborted = createRedispatchAborted({
  sourceFor: getSourceForProjectId,
  managerFor,
  dispatch: (item, manager, agentId, opts) => dispatcher.dispatch(item, manager, agentId, opts),
})

/**
 * Reintenta el agente de un `AgentAbortRecord` y asienta el resultado en
 * `agent_aborts` — la pieza que comparten el barrido automático de
 * `daemon.ts` y el botón manual de `routes/agent-aborts.ts`, para que las
 * dos vías traten un `deferred`/`skipped`/fallo de la misma forma exacta.
 *
 * Deliberadamente NO se espera desde ninguno de los dos callers: un run
 * puede tardar minutos, y bloquear el barrido (o la respuesta HTTP del botón
 * manual, que si no el proxy la corta por timeout) hasta que termine
 * dejaría todo lo demás sin reintentar mientras tanto. Que sea `async` acá
 * es sólo para que el caller pueda optar por esperarla si quiere (los tests
 * lo hacen); en producción ninguno lo hace.
 */
export async function retryAbortRecord(record: AgentAbortRecord): Promise<void> {
  agentAbortRepo.markRetrying(record.id)
  try {
    const result = await redispatchAborted(record)
    if (!result.ok) {
      log.warn(
        { taskId: record.taskId, agentId: record.agentId, reason: result.reason },
        'Retry de abort no pudo despachar',
      )
      agentAbortRepo.recordFailedAttempt(record.id, `retry-dispatch-failed: ${result.reason}`)
      return
    }
    if (result.outcome === 'deferred') {
      // Cap de proyecto/agente/provider al tope, o lock de la task tomado —
      // NO es un fallo del agente, así que no quema `attempts`.
      log.info(
        { taskId: record.taskId, agentId: record.agentId },
        'Retry de abort diferido por capacidad',
      )
      agentAbortRepo.deferRetry(record.id)
      return
    }
    if (result.outcome === 'skipped') {
      // Nada matchea o el issue está bloqueado — reintentar en 30s no
      // cambia nada, a diferencia de `deferred`. Sí cuenta como intento.
      log.info({ taskId: record.taskId, agentId: record.agentId }, 'Retry de abort saltado')
      agentAbortRepo.recordFailedAttempt(record.id, `retry-not-dispatched: ${result.outcome}`)
    }
    // outcome === 'dispatched': el run está en curso. Cuando termine,
    // Agent.ts mismo cierra el ciclo — `resolveOpen` si salió bien o dio un
    // error real, `recordAbort` (con su propio backoff) si volvió a
    // abortar. Acá no hay nada más que hacer.
  } catch (err) {
    log.error({ err, taskId: record.taskId, agentId: record.agentId }, 'Retry de abort falló')
    agentAbortRepo.recordFailedAttempt(
      record.id,
      `retry-dispatch-failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Runs que quedaron a mitad de camino con un checkpoint resumible —
 * `run_checkpoints`, ver docstring de la migración 066— y que NO pasaron por
 * `agent_aborts` (eso es sólo el upstream-abort). Dos orígenes:
 *
 *  - Un crash del server a mitad de vuelta: `reconcileOrphanedRuns` (boot)
 *    dejó la fila de `execution_logs` ABIERTA a propósito, reservada para que
 *    el próximo dispatch de la task la retome.
 *  - Un `runState.truncated` (budget/iteraciones agotadas, o un
 *    `mcp_tool_use` sin pareo) — mismo trato: el `finally` del orquestador
 *    conserva el checkpoint en vez de borrarlo.
 *
 * En los dos casos la fila de `execution_logs` sigue sin `finishedAt`, así
 * que ya aparece en Ejecuciones como "en vuelo" — pero indefinidamente, sin
 * nadie corriendo, hasta que algo vuelva a disparar la regla de esa task.
 * Esta lista es lo que hace visible ESE estanque y da el botón para
 * destrabarlo (`POST /api/tasks/:id/run`, que re-emite el status actual para
 * que las reglas la vuelvan a tomar y el dispatch siguiente use
 * `AgentOrchestrator.loadResume`).
 *
 * `resumable` repite los mismos tres gates que `loadResume` — no hay forma de
 * preguntarle al orquestador sin dispatchar de verdad, así que se recalculan
 * acá con las mismas constantes. Falso positivo/negativo posible si alguien
 * cambia una constante sin tocar la otra; ambas viven en
 * `@ia-flow/agent-engine` y se importan, no se copian.
 */
export async function listRecoverableCheckpoints(
  projectId?: string,
): Promise<RecoverableCheckpoint[]> {
  const checkpoints = await runCheckpointRepo.listAll()
  const scoped = checkpoints.filter((cp) => !projectId || cp.projectId === projectId)

  // Una task que la fuente ya marca cerrada no tiene nada que recuperar —
  // mismo criterio que domain/task-disposition.ts (`meta.state === 'closed'`),
  // para no inventar una segunda definición de "terminada". Se resuelve UNA
  // vez por proyecto (getItems() está memoizado con TTL en las fuentes
  // GitHub) y no por fila, para no convertir este GET en N requests.
  const itemsByProject = new Map<string, Map<string, SourceItem>>()
  for (const projId of new Set(
    scoped.map((cp) => cp.projectId).filter((id): id is string => Boolean(id)),
  )) {
    try {
      const items = await getSourceForProjectId(projId).getItems()
      itemsByProject.set(projId, new Map(items.map((item) => [item.id, item])))
    } catch (err) {
      log.warn(
        { err, projectId: projId },
        'No se pudo cargar items del proyecto para filtrar checkpoints de tasks cerradas',
      )
    }
  }

  function isTaskClosed(cp: RunCheckpoint): boolean {
    if (!cp.projectId) return false
    const item = itemsByProject.get(cp.projectId)?.get(cp.taskId)
    return (item?.meta as { state?: string } | undefined)?.state === 'closed'
  }

  // El checkpoint se guarda EN CADA VUELTA del loop (ver AgentOrchestrator),
  // no sólo al crashear — así que un run que sigue corriendo normalmente
  // también tiene una fila viva en `run_checkpoints` en todo momento. Sin
  // este filtro, todo run en curso aparecía acá como "recuperable" aunque
  // nada se hubiera cortado. El registro de pending tasks es la única fuente
  // que sabe qué corre DE VERDAD ahora mismo en este proceso.
  const runningRunIds = new Set(
    listPendingTasks()
      .map(([, p]) => p.runId)
      .filter((id): id is string => Boolean(id)),
  )

  const now = Date.now()
  return scoped
    .filter((cp) => !isTaskClosed(cp) && !runningRunIds.has(cp.runId))
    .map((cp) => {
      const row = executionLogRepo.getById(cp.runId)
      const ageMs = now - Date.parse(cp.updatedAt)
      const resumable =
        (!Number.isFinite(ageMs) || ageMs <= MAX_RESUME_AGE_MS) && cp.attempts < MAX_RESUME_ATTEMPTS
      return {
        runId: cp.runId,
        taskId: cp.taskId,
        taskTitle: row?.taskTitle ?? null,
        projectId: cp.projectId ?? row?.projectId ?? null,
        agentId: cp.agentId ?? row?.agentId ?? null,
        updatedAt: cp.updatedAt,
        attempts: cp.attempts,
        resumable,
        stillOpen: row ? row.finishedAt == null : false,
        row,
      }
    })
    .filter((cp) => {
      // Sólo sync: `run_checkpoints` hoy sólo lo escribe `anthropic-api` (ver
      // CLAUDE.md, "El checkpoint: dónde va el run, en disco" — un provider de
      // terminal nunca llama a `saveCheckpoint`), así que en la práctica esto
      // nunca filtra nada. Se re-chequea igual, explícito y no por omisión:
      // esta lista alimenta tanto el botón manual como el redespacho
      // automático (`checkpoint-sweep` en `daemon.ts`), y ESE consumidor tiene
      // que poder confiar en el discriminador sync/async sin volver a leer
      // `execution_logs` por su cuenta — una fila con `sessionId` es una
      // sesión tmux/iterm/remota, y redespacharla la duplicaría.
      if (cp.row?.sessionId) {
        log.warn(
          { taskId: cp.taskId, runId: cp.runId },
          'Checkpoint con sessionId — no debería existir (ver saveCheckpoint), se excluye por seguridad',
        )
        return false
      }
      return true
    })
    .map(({ row: _row, ...cp }) => cp)
}

/**
 * Redespacha en soledad los checkpoints sync huérfanos (ver docstring de
 * `createCheckpointSweep`) — el barrido periódico de `daemon.ts` y, si algún
 * día hace falta, un botón manual lo comparten, igual que `retryAbortRecord`
 * arriba con el barrido de aborts.
 */
export const redispatchRecoverableCheckpoints = createCheckpointSweep({
  listRecoverableCheckpoints,
  isRunning: (taskId) => Boolean(getPendingTask(taskId)),
  sourceFor: getSourceForProjectId,
  runTaskNow: (input, source, eventSource) => runTaskNowUseCase.execute(input, source, eventSource),
})

let registered = false

export function registerActions(): void {
  // Idempotente: los dos entrypoints (server y runner) lo llaman, y en tests
  // el módulo puede importarse más de una vez.
  if (registered) return
  registered = true

  registerAction(
    new AgentAction({
      managerFor,
      // El agente lo elige la REGLA, no `selectAgent`: el dispatcher recibe el
      // id y saltea su propio gate de selección. Es lo que permite que un
      // `pr.opened` corra un agente sobre un issue cuyo status no matchearía
      // ninguna activación.
      dispatch: async (
        item: IssueItem,
        manager: IIssueManager,
        agentId: string,
        ruleId: string,
        event: { id: string; type: string; position: number; traceId?: string },
        brief?: string,
        exits?: DispatchOptions['exits'],
        liveInject?: boolean,
      ) => {
        // El `state` es el canal de vuelta del run: `Agent.run` escribe ahí su
        // texto final y, si el agente declara contrato, la salida estructurada
        // que entregó por `submit_output`. Es el mismo mecanismo con el que
        // `runSubAgent` le devuelve el resultado a un agente padre.
        const state: AgentRunState = {}
        const outcome = await dispatcher.dispatch(item, manager, agentId, {
          ruleId,
          event,
          brief,
          exits,
          liveInject,
          state,
        })
        // `state.runOutcome` es el resultado REAL del run (`success`/`error`/
        // `cancelled`/`truncated`) — lo escribe `Agent.run` en `runState` a la
        // vez que lo persiste en `execution_logs.outcome` (ver
        // `AgentRunState.runOutcome`). `AgentAction` lo usa para publicar
        // `run.finished` con el outcome real en vez del `DispatchOutcome` de
        // acá arriba.
        return {
          outcome,
          output: state.structuredOutput ?? state.output,
          runOutcome: state.runOutcome,
        }
      },
      // Los eventos de GitHub (`pr.*`, `ci.finished`) traen el PR, no el issue
      // del board. Sin esto una regla sobre cualquiera de ellos no dispara.
      resolveItem: resolveEventItem,
    }),
  )

  registerAction(new HttpAction({ resolveSecrets: interpolateSecrets }))
  registerAction(new EmitAction())

  // `script` se registra SIEMPRE: sus gates se evalúan por ejecución, no acá.
  // Registrarla condicionalmente haría que el editor no la ofrezca y que la
  // razón (falta el env, falta el token) sea invisible — el operador vería una
  // opción que no existe en vez de un motivo.
  registerAction(
    new ScriptAction({
      workspaceFor: async (event) => {
        const projectId = event.scope.projectId
        const repo = event.scope.repos?.[0]
        if (!projectId || !repo) return null
        return repoRepo.getByProject(repo, projectId)?.path ?? null
      },
    }),
  )
}
