import {
  isProjectPaused,
  listPausedProjects,
  pauseProject,
  resumeProject,
} from '@ia-flow/issue-sources'
import type { IPollingGate } from '../../domain/ports/IPollingGate.js'

// Adapter sobre el Set de módulo de @ia-flow/issue-sources
// (dispatch/polling-pause.ts), que es lo que el dispatcher consulta en cada
// tick. Existe para que application/ hable con un port y no con ese módulo.
export class IssueSourcesPollingGate implements IPollingGate {
  pause(projectId: string): void {
    pauseProject(projectId)
  }

  resume(projectId: string): void {
    resumeProject(projectId)
  }

  isPaused(projectId: string): boolean {
    return isProjectPaused(projectId)
  }

  listPaused(): string[] {
    return listPausedProjects()
  }
}
