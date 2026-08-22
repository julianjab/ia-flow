// How the daemon learns about work for a project.
//
//   · 'webhook' (default) — the provider pushes events to
//     POST /api/webhooks/github and each event triggers one scan cycle.
//     A slow safety-net interval still runs so a dropped delivery can't
//     stall a project forever (see WebhookIssueManager).
//   · 'polling'           — classic pull loop on IA_FLOW_POLL_INTERVAL_MS.
//
// Resolution order (first hit wins):
//   1. project.settings.daemonMode
//   2. IA_FLOW_DAEMON_MODE env var
//   3. DEFAULT_DAEMON_MODE ('webhook')

import type { Project } from '@ia-flow/shared'

export type DaemonMode = 'webhook' | 'polling'

export const DEFAULT_DAEMON_MODE: DaemonMode = 'webhook'

/** The canonical modes, in the order a picker should offer them. Aliases
 * below are accepted on input but never surfaced as choices. */
export const DAEMON_MODES: readonly DaemonMode[] = ['webhook', 'polling']

// Aliases so both the env var and the per-project setting accept the words
// people actually type ('pull', 'pulling', 'push', ...).
const ALIASES: Record<string, DaemonMode> = {
  webhook: 'webhook',
  webhooks: 'webhook',
  push: 'webhook',
  event: 'webhook',
  events: 'webhook',
  polling: 'polling',
  poll: 'polling',
  pull: 'polling',
  pulling: 'polling',
  interval: 'polling',
}

/** Normalize an arbitrary value into a DaemonMode. Returns null when unknown. */
export function parseDaemonMode(raw: unknown): DaemonMode | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  return ALIASES[key] ?? null
}

/** Mode configured process-wide via IA_FLOW_DAEMON_MODE. */
export function envDaemonMode(): DaemonMode {
  return parseDaemonMode(process.env.IA_FLOW_DAEMON_MODE) ?? DEFAULT_DAEMON_MODE
}

/** Effective mode for one project — per-project setting beats env beats default. */
export function resolveDaemonMode(project: Pick<Project, 'settings'>): DaemonMode {
  return parseDaemonMode(project.settings?.daemonMode) ?? envDaemonMode()
}
