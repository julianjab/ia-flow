import type { StatusConfig } from '@ia-flow/shared'
import type { IAgentRepository } from '../../domain/ports/IAgentRepository.js'
import type { IStatusRepository } from '../../domain/ports/IStatusRepository.js'

// IStatusRepository backed by the agent roster instead of the `statuses`
// table/YAML — for SourceIssueManager's scan-cycle prefilter (the ONLY
// runtime consumer of a statusRepo outside the UI, see
// packages/issue-sources/src/dispatch/source-issue-manager.ts:
// `statusRepo.list(projectId)` decides which statuses are worth fetching
// before dispatch ever runs). `statuses.yaml`/the `statuses` table stopped
// being load-bearing for dispatch once TaskDispatcher started gating on
// `selectAgent` directly (see TaskDispatcher.dispatch) — this adapter
// finishes that: the scan cycle now derives "which statuses matter" from
// `AgentDefinition.statusName` instead of a separate, easy-to-desync list
// that a human has to keep in sync by hand.
//
// A global candidate agent (statusName == null, "matches any status") can't
// be represented as a finite name list — same limitation the table-backed
// version already had (an empty/missing statuses row for a status also
// meant "not scanned"), so this isn't a regression, just carried forward.
// Read-only: every mutating method throws, same as the Yaml*Repository
// family — nothing should be writing statuses through this port anymore.
export class AgentDerivedStatusRepository implements IStatusRepository {
  constructor(private agentRepo: IAgentRepository) {}

  list(projectId?: string): StatusConfig[] {
    const agents =
      projectId === undefined
        ? this.agentRepo.inScope(undefined)
        : this.agentRepo.visibleTo(projectId)
    const names = new Set<string>()
    for (const agent of agents) {
      if (agent.statusName) names.add(agent.statusName)
    }
    return [...names].map((name) => ({ name, projectId: projectId ?? undefined }))
  }

  getByName(projectId: string, name: string): StatusConfig | null {
    const nameLower = name.toLowerCase()
    return this.list(projectId).find((s) => s.name.toLowerCase() === nameLower) ?? null
  }

  upsert(_status: StatusConfig, _position: number, _projectId: string): void {
    throw new Error(
      'AgentDerivedStatusRepository es de solo lectura — los statuses salen del roster de agentes (AgentDefinition.statusName), editá el agente en vez de esto.',
    )
  }

  deleteByName(_projectId: string, _name: string): void {
    throw new Error(
      'AgentDerivedStatusRepository es de solo lectura — los statuses salen del roster de agentes (AgentDefinition.statusName), editá el agente en vez de esto.',
    )
  }

  clearScope(_projectId: string): void {
    throw new Error(
      'AgentDerivedStatusRepository es de solo lectura — los statuses salen del roster de agentes (AgentDefinition.statusName), editá el agente en vez de esto.',
    )
  }
}
