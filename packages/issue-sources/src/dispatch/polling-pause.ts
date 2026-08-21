// In-memory per-project pause flag for the polling loop — the runtime gate the
// dispatcher checks on every tick (source-dispatcher.ts).
//
// This module stays storage-free on purpose: the server owns durability. It
// mirrors every flip into `projects.settings.pollingPaused` and re-hydrates
// this set at boot (apps/server/src/application/polling-pause.ts), so a paused
// project stays paused across a daemon restart. Anything calling pauseProject
// directly (tests, in-process callers) only affects this process.

const paused = new Set<string>()

export function pauseProject(projectId: string): void {
  paused.add(projectId)
}

export function resumeProject(projectId: string): void {
  paused.delete(projectId)
}

export function isProjectPaused(projectId: string): boolean {
  return paused.has(projectId)
}

export function listPausedProjects(): string[] {
  return [...paused]
}
