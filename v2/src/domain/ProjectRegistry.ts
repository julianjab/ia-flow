import type { Project } from './Project.js'

/** Resuelve Project por id — lo que Engine.dispatch necesita para aplicar
 *  `Project.settings.disabledRuleIds`/`baseWhen` contra cada Rule candidata. */
export class ProjectRegistry {
  private readonly projects = new Map<string, Project>()

  register(project: Project): void {
    throw new Error('not implemented — this.projects.set(project.id, project)')
  }

  resolve(id: string): Project | undefined {
    throw new Error('not implemented — this.projects.get(id)')
  }
}
