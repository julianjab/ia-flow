import type { Repo } from './Repo.js'

export interface ProjectSettings {
  maxConcurrentDispatches?: number
  daemonMode?: 'webhook' | 'polling'
}

export interface ProjectProps {
  id: string
  name: string
  repos: Repo[]
  settings?: ProjectSettings
}

/** Agrupa la fuente de issues (fuera de este esqueleto), sus repos y sus settings de operación.
 *  El roster de agentes NO vive acá — en v2 la activación es de la Rule, no del Project. */
export class Project {
  readonly id: string
  name: string
  repos: Repo[]
  settings: ProjectSettings

  constructor(props: ProjectProps) {
    this.id = props.id
    this.name = props.name
    this.repos = props.repos
    this.settings = props.settings ?? {}
  }

  findRepo(name: string): Repo | undefined {
    return this.repos.find((r) => r.name === name)
  }
}
