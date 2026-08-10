// ProjectSource — read-side abstraction over a project's issue provider.
//
// Sibling of IssueManager: the manager is what the *daemon* uses to poll
// items and drive transitions (write path). ProjectSource is what the UI /
// REST layer uses to *read* metadata (status options, item list) for a
// specific project row, without hard-coding GitHub.
//
// Adding a new provider (Linear, Jira, local YAML dirs, ...):
//   1. Implement `ProjectSource` in a new file under project-sources/.
//   2. Register it in registry.ts alongside the existing ones.
//   3. No route or UI change needed — /api/projects/:id/statuses etc. resolve
//      the source through the registry using the project's stored config.

export interface StatusOption {
  name: string
  // Optional colour/description if the provider exposes it (github does not).
  description?: string
}

export interface SourceItem {
  id: string
  title: string
  status: string
  repos?: string
  // Free-form provider-specific metadata — routes/UI treat this as opaque.
  meta?: Record<string, unknown>
}

export interface ProjectSource {
  /** Stable id of the source impl — used by the registry, not shown to users. */
  readonly kind: string

  /** Field options for the project (statuses, types, etc.). */
  getStatuses(opts?: { refresh?: boolean }): Promise<StatusOption[]>

  /** Items currently in the project, optionally filtered by status. */
  getItems(opts?: { status?: string; refresh?: boolean }): Promise<SourceItem[]>

  /** Update a scalar field on a single item. Not all providers support all fields. */
  setItemField?(itemId: string, field: string, value: string): Promise<void>
}
