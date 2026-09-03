import type { DispatchOutcome, IIssueManager, ProjectSource } from '@ia-flow/issue-sources'
import { defaultToIssueItem } from '@ia-flow/issue-sources'
import type { AgentAbortRecord } from '../../domain/ports/IAgentAbortRepository.js'
import { createLogger } from '../../logger.js'

const log = createLogger('action:redispatch-aborted')

/**
 * Vuelve a correr el agente de un `AgentAbortRecord` — el mismo camino que
 * `AgentAction` usa para un dispatch guiado por regla (`resolve-event-item.ts`),
 * pero yendo directo de `(projectId, taskId)` a un item, sin evento ni scope.
 *
 * Es el único lugar que sabe reconstruir un `IssueItem` sin un scan completo,
 * así que el barrido automático (`daemon.ts`) y el botón manual
 * (`routes/agent-aborts.ts`) comparten esta implementación en vez de cada uno
 * armar su propia versión de "dame el item de esta task".
 */
export interface RedispatchAbortedDeps {
  sourceFor(projectId: string): ProjectSource
  managerFor(projectId: string): IIssueManager | undefined
  dispatch(
    item: import('@ia-flow/issue-sources').IssueItem,
    manager: IIssueManager,
    agentId: string,
    opts: { ruleId: string },
  ): Promise<DispatchOutcome>
}

export function createRedispatchAborted(deps: RedispatchAbortedDeps) {
  return async function redispatchAborted(
    record: AgentAbortRecord,
  ): Promise<{ ok: true; outcome: DispatchOutcome } | { ok: false; reason: string }> {
    const manager = deps.managerFor(record.projectId)
    if (!manager) return { ok: false, reason: `Proyecto '${record.projectId}' sin manager activo` }

    const source = deps.sourceFor(record.projectId)
    const raw = source.getItemById
      ? await source.getItemById(record.taskId)
      : (await source.getItems()).find((i) => i.id === record.taskId)
    if (!raw) return { ok: false, reason: `Task '${record.taskId}' no encontrada en la fuente` }

    const item = {
      ...(source.toIssueItem ? source.toIssueItem(raw) : defaultToIssueItem(raw)),
      projectId: record.projectId,
    }

    try {
      const outcome = await deps.dispatch(item, manager, record.agentId, {
        ruleId: `agent-abort-retry:${record.id}`,
      })
      return { ok: true, outcome }
    } catch (err) {
      log.warn(
        { taskId: record.taskId, agentId: record.agentId, err },
        'Retry de abort falló al despachar',
      )
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }
}
