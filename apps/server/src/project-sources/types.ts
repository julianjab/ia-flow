// ProjectSource — abstraction over a project's issue provider.
//
// Used by both:
//   · REST layer (/api/projects/:id/source/*) for UI reads.
//   · The daemon's PollingIssueManager, which polls getItems() and delegates
//     write-side per-item concerns (status transitions, working flag,
//     comments, saveOutput) to source-provided TransitionManagers.
//
// Adding a new provider (Linear, Jira, ...):
//   1. Implement `ProjectSource` in a new file under project-sources/.
//   2. Register it in registry.ts alongside the existing ones.
//   3. No route, no manager subclass, no factory. The daemon picks it up
//      via getSourceForProject() once a project row references it.

import type { TransitionManager } from '../issue-managers/transition-manager.js'
import type { BroadcastFn, IssueItem } from '../issue-managers/types.js'

export interface StatusOption {
  name: string
  // Optional colour/description if the provider exposes it (github does not).
  description?: string
}

// A field exposed by the underlying provider (GitHub Project v2 column, Linear
// custom field, …). The UI uses this to build condition editors that reference
// any project field, not just Status.
export interface SourceProjectField {
  name: string
  // Provider-native type. GitHub Project v2 emits `SINGLE_SELECT` | `TEXT` |
  // `NUMBER` | `DATE` | `ITERATION`. Other providers keep their own strings —
  // the web treats it as opaque.
  dataType: string
  // Populated for enum-like fields (SINGLE_SELECT). Empty otherwise.
  options?: string[]
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

  /**
   * All fields exposed by the provider, so the UI can build condition editors
   * that reference any field (Status, Priority, custom fields, …). Sources
   * that only surface a Status field can omit this — callers fall back to a
   * synthetic Status field derived from getStatuses().
   */
  getFields?(opts?: { refresh?: boolean }): Promise<SourceProjectField[]>

  /** Items currently in the project, optionally filtered by status. */
  getItems(opts?: { status?: string; refresh?: boolean }): Promise<SourceItem[]>

  /** Update a scalar field on a single item. Not all providers support all fields. */
  setItemField?(itemId: string, field: string, value: string): Promise<void>

  /**
   * Build a per-item TransitionManager (the write side used by AgentOrchestrator
   * to apply status transitions, mark working, post comments, save output).
   * Sources that don't drive an active work loop (e.g. LocalProjectSource used
   * only from the UI) can omit this — the daemon skips them.
   */
  getTransitionManager?(item: IssueItem, broadcast: BroadcastFn): TransitionManager

  /**
   * Convert a fetched SourceItem into the daemon-facing IssueItem shape.
   * Default (see helper below) copies the common fields — override when the
   * provider needs to stash extra metadata for its TransitionManager.
   */
  toIssueItem?(item: SourceItem): IssueItem

  /**
   * Optional startup hook — e.g. reset stuck "working" flags on crash recovery.
   * Called once by the daemon before the first poll.
   */
  onDaemonStart?(): Promise<void>

  /**
   * Diagnose whether this source has everything it needs for the daemon to
   * poll and drive transitions. Fields the daemon relies on (Status,
   * Working, …) surface as either `missing` (breaks polling / correctness)
   * or `warnings` (works but degraded).
   */
  getHealth?(): Promise<SourceHealth>

  /**
   * Return unfinished blockers for `item`. Absence = source doesn't model
   * dependencies (behaves as "no blockers"). Implementations decide what
   * counts as "unfinished":
   *   · GitHub — issue.state !== 'closed'
   *   · Local  — blocker task status !== 'Done' (case-insensitive)
   */
  getBlockers?(item: IssueItem): Promise<Blocker[]>

  /**
   * Fetch a single item by its source-native ID. Used by REST endpoints that
   * need to resolve an item from URL params (blockers, detail views). Sources
   * that already list everything via getItems can implement this via a
   * linear scan; sources that stream (github pagination) should do a direct
   * lookup. Absence = the caller must fall back to getItems().
   */
  getItemById?(id: string): Promise<SourceItem | null>
}

export interface Blocker {
  id: string
  ref?: string
  title?: string
  status?: string
  url?: string
}

export interface SourceHealthField {
  name: string
  purpose: string
}

export interface SourceHealth {
  ok: boolean
  // Fields the daemon requires. Any entry here → ok=false.
  missing: SourceHealthField[]
  // Fields that are optional but recommended (e.g. Repos for context).
  warnings: SourceHealthField[]
  // Free-form human message. Empty on healthy sources.
  message?: string
}

/**
 * Default SourceItem → IssueItem mapping. Providers that need extra data in
 * `meta` (issueId, issueNumber, ...) override toIssueItem() themselves.
 */
export function defaultToIssueItem(item: SourceItem): IssueItem {
  return {
    id: item.id,
    title: item.title,
    description: '',
    type: (item.meta?.type as string) ?? '',
    repos: item.repos
      ? item.repos
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : [],
    status: item.status,
    agentWorking: item.meta?.working === true,
    meta: item.meta,
  }
}
