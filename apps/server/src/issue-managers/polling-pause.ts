// In-memory per-project pause flag for the polling loop.
//
// Not persisted: a daemon restart resumes every project. Intentional — pausing
// is an operator escape hatch (rate-limit relief, noisy source, debugging),
// not a durable configuration knob. If we later need a "keep it paused across
// restarts" mode, promote it to project_settings instead of extending this.

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
