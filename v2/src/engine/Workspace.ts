export interface WorkspaceRepoRequest {
  name: string
  path?: string
  githubOwner?: string
  githubRepo?: string
}

/**
 * Lo que el engine sabe pedir: coordenadas, no paths de una máquina. Viaja
 * completo hasta donde sea que el Provider corra (incluso remoto) porque no
 * asume ningún filesystem del lado del engine.
 */
export interface WorkspaceRequest {
  taskId: string
  repos: WorkspaceRepoRequest[]
  branch?: string
  workflow?: 'worktree' | 'branch' | 'main'
  needsWrite: boolean
}

/**
 * Lo que el Provider devuelve tras resolver DÓNDE, en SU disco. `release` es
 * la contracara de `prepare`: el Provider que ensucia el disco declara cómo
 * se limpia; quien la invoca (en su `finally`) no necesita saber de qué
 * Provider vino.
 */
export interface WorkspacePlan {
  repoPaths: Record<string, string>
  writePaths?: string[]
  cwd?: string
  branch?: string
  worktreePath?: string
  release?(): Promise<void>
}

/**
 * Convención de nombres compartida por todo provisioner — si cada uno la
 * derivara por su cuenta, dos agentes de la misma cadena podrían terminar
 * mirando directorios distintos para la misma task.
 */
export class WorkspaceLayout {
  static worktreePath(base: string, repo: string, issueNumber: number | string): string {
    return `${base}/${repo}/.worktrees/task-${issueNumber}`
  }

  static branchName(task: { branch?: string; id: string }): string {
    return task.branch ?? `task/${task.id}`
  }
}
