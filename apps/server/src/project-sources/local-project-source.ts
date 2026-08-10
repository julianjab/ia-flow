import type { ProjectSource, SourceItem, StatusOption } from './types.js'

// Placeholder for the local (file-backed) issue source. Currently returns
// empty lists — the daemon's LocalIssueManager owns the read-side today via
// file watchers. Wire this up when the local flow gains statuses configurable
// per-project rather than hardcoded directory names.
export class LocalProjectSource implements ProjectSource {
  readonly kind = 'local'

  async getStatuses(): Promise<StatusOption[]> {
    return []
  }

  async getItems(): Promise<SourceItem[]> {
    return []
  }
}
