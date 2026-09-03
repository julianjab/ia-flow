import type { AgentRunState, DispatchOptions } from '@ia-flow/agent-engine'
import type { IIssueManager, IssueItem } from '@ia-flow/issue-sources'
// Registro de las acciones que este daemon sabe ejecutar.
//
// Vive en `composition/` y no en el container mismo porque es cableado con
// forma de side effect (`registerAction` puebla un Map del paquete `rules`), y
// mezclarlo con las definiciones de repositorios haría más difícil ver qué se
// registra. Lo importa el arranque, una vez.
import { registerAction } from '@ia-flow/rules'
import { AgentAction } from '../adapters/actions/agent-action.js'
import { EmitAction } from '../adapters/actions/emit-action.js'
import { HttpAction } from '../adapters/actions/http-action.js'
import { createRedispatchAborted } from '../adapters/actions/redispatch-aborted.js'
import { createResolveEventItem } from '../adapters/actions/resolve-event-item.js'
import { createResolveRuleConversation } from '../adapters/actions/resolve-rule-conversation.js'
import { ScriptAction } from '../adapters/actions/script-action.js'
import type { AgentAbortRecord } from '../domain/ports/IAgentAbortRepository.js'
import { createLogger } from '../logger.js'
import {
  agentAbortRepo,
  dispatcher,
  getSourceForProjectId,
  interpolateSecrets,
  repoRepo,
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
 *  `daemon.ts`) no tenga que mantener su propio índice. */
export function managerFor(projectId: string): IIssueManager | undefined {
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

let registered = false

export function registerActions(): void {
  // Idempotente: los dos entrypoints (server y runner) lo llaman, y en tests
  // el módulo puede importarse más de una vez.
  if (registered) return
  registered = true

  registerAction(
    new AgentAction({
      managerFor: (projectId) => managers.get(projectId),
      // El agente lo elige la REGLA, no `selectAgent`: el dispatcher recibe el
      // id y saltea su propio gate de selección. Es lo que permite que un
      // `pr.opened` corra un agente sobre un issue cuyo status no matchearía
      // ninguna activación.
      dispatch: async (
        item: IssueItem,
        manager: IIssueManager,
        agentId: string,
        ruleId: string,
        event: { id: string; type: string; position: number },
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
        return { outcome, output: state.structuredOutput ?? state.output }
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
