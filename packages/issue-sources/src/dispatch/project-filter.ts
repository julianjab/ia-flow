// Filtro general de proyecto, previo a cualquier agente — un nivel por encima
// de `selectAgent` (packages/agent-engine/src/agent-selection.ts). Si un item no
// lo pasa, `SourceIssueManager.runCycle` ni siquiera lo despacha: no llega a
// TaskDispatcher/selectAgent. Configurado vía `project.settings` (mismo bag
// abierto que ya usa `daemon-mode.ts` para `project.settings.daemonMode`), no
// vía CRUD ni entidad propia.
//
// No baja la cantidad de llamadas del fetch inicial (`source.getItems()`) —
// ninguna fuente hoy soporta filtrar status/repo server-side — pero evita que
// un item descartado entre al tracking de `dispatching`/`pending` y llegue a
// evaluarse contra ningún agente.
import { type WhenCondition, evalWhen } from '@ia-flow/shared'
import type { Project } from '@ia-flow/shared'
import type { IssueItem } from '../contract.js'

export interface ProjectFilter {
  statusName?: string
  repoName?: string
  when?: WhenCondition[]
}

/** Lee `project.settings.{statusName,repoName,when}`. `undefined` si ninguno está seteado. */
export function resolveProjectFilter(settings: Project['settings']): ProjectFilter | undefined {
  if (!settings) return undefined
  const { statusName, repoName, when } = settings as Record<string, unknown>
  if (!statusName && !repoName && !when) return undefined
  return {
    statusName: typeof statusName === 'string' ? statusName : undefined,
    repoName: typeof repoName === 'string' ? repoName : undefined,
    when: Array.isArray(when) ? (when as WhenCondition[]) : undefined,
  }
}

export function matchesProjectFilter(item: IssueItem, filter: ProjectFilter | undefined): boolean {
  if (!filter) return true
  if (filter.statusName && item.status?.toLowerCase() !== filter.statusName.toLowerCase()) {
    return false
  }
  if (filter.repoName && !item.repos?.includes(filter.repoName)) return false
  if (filter.when && !evalWhen(item as unknown as Record<string, unknown>, filter.when)) {
    return false
  }
  return true
}
