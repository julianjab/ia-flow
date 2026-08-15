import { type ProjectConfig, memoize } from '@ia-flow/shared'
import type { IAgentRepository } from '../../../domain/ports/IAgentRepository.js'
import type { IGlobalSettingsRepository } from '../../../domain/ports/IGlobalSettingsRepository.js'
import type { IProjectConfigRepository } from '../../../domain/ports/IProjectConfigRepository.js'
import type { IProjectRepository } from '../../../domain/ports/IProjectRepository.js'
import type { IStatusRepository } from '../../../domain/ports/IStatusRepository.js'
import type { ISystemPromptRepository } from '../../../domain/ports/ISystemPromptRepository.js'

// Read-only aggregate over per-domain repos. Writes go through the granular
// per-domain endpoints (agents-crud, system-prompts, statuses, projects PATCH).
//
// scope semantics:
//   undefined → default project
//   string    → that specific project — reads use overlay (project + globals)
//   null      → global rows only (project_id IS NULL); statuses are empty
//               since they always belong to a project
export class SqliteProjectConfigRepo implements IProjectConfigRepository {
  constructor(
    private systemPromptRepo: ISystemPromptRepository,
    private projectRepo: IProjectRepository,
    private statusRepo: IStatusRepository,
    private settingsRepo: IGlobalSettingsRepository,
    private agentRepo: IAgentRepository,
  ) {}

  // Short TTL, not "forever": this only exists to collapse the N
  // getConfig(sameProjectId) calls TaskDispatcher.dispatch makes within a
  // single SourceIssueManager scan cycle (one per fetched item, now that
  // there's no status prefilter bounding that count — see
  // packages/issue-sources/src/dispatch/source-issue-manager.ts) into one
  // real read. 5s comfortably covers a cycle's fire-and-forget dispatch
  // burst while staying well under the 30s default poll interval, so an
  // agent/system-prompt edit via the CRUD routes is still visible on the
  // very next cycle without needing those routes to invalidate this cache.
  @memoize({
    ttlMs: 5_000,
    // Explicit key: the default `JSON.stringify(args)` collapses `undefined`
    // and `null` to the same `"[null]"` string, but they mean different
    // things here (default project vs. globals-only) — see the scope
    // semantics comment on the class above.
    key: (scope) => (scope === undefined ? '__default__' : scope === null ? '__global__' : scope),
  })
  async getConfig(scope?: string | null): Promise<ProjectConfig> {
    const resolved = scope === undefined ? this.projectRepo.getDefaultId() : scope
    const project = resolved === null ? null : this.projectRepo.get(resolved)
    const systemPrompts =
      resolved === null
        ? this.systemPromptRepo.inScope(null)
        : this.systemPromptRepo.visibleTo(resolved)
    const agents =
      resolved === null ? this.agentRepo.inScope(null) : this.agentRepo.visibleTo(resolved)
    const scanRoots = this.settingsRepo.getScanRoots()
    return {
      project: {
        name: project?.name,
        language: project?.language,
      },
      systemPrompts: systemPrompts.length ? systemPrompts : undefined,
      agents,
      statuses: resolved === null ? [] : this.statusRepo.list(resolved),
      scanRoots: scanRoots.length ? scanRoots : undefined,
    }
  }
}
