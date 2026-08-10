import type { ITaskRepository } from '../../domain/ports/ITaskRepository.js'
import type { ProjectSource, SourceItem, StatusOption } from '../../project-sources/types.js'

// File-backed source. Status list comes from the tasks/ directory tree — one
// dir per status name. Items still flow through LocalIssueManager (file
// watcher); getItems returns [] here because the daemon owns the read side.
export class LocalProjectSource implements ProjectSource {
  readonly kind = 'local'

  constructor(private taskRepo: ITaskRepository) {}

  async getStatuses(): Promise<StatusOption[]> {
    const names = await this.taskRepo.listStatuses()
    return names.map((name) => ({ name }))
  }

  async getItems(): Promise<SourceItem[]> {
    return []
  }
}
