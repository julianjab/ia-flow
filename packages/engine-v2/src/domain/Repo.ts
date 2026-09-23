import { Catalog } from '../shared/Catalog.js'

export interface RepoProps {
  name: string
  projectId: string
  path?: string
}

/**
 * Un path con nombre, nada más. `githubOwner`/`githubRepo`/`slackReview*`
 * vivían acá antes — se borraron: son propiedades de un generador
 * (GitHub/Slack) coladas en una entidad que el engine tiene que poder usar
 * sin saber qué generador existe del otro lado. `path` es lo único que
 * `ScriptAction` necesita para resolver un `cwd`.
 *
 * Se autoindexa como el resto del dominio — clave compuesta `projectId:name`
 * porque `name` sólo es único DENTRO de un proyecto (dos proyectos pueden
 * tener cada uno un repo "backend").
 */
export class Repo {
  private static readonly catalog = new Catalog<Repo>((r) => `${r.projectId}:${r.name}`)

  static register(repo: Repo): void {
    Repo.catalog.register(repo)
  }

  static resolve(projectId: string, name: string): Repo | undefined {
    return Repo.catalog.resolve(`${projectId}:${name}`)
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    Repo.catalog.reset()
  }

  readonly name: string
  readonly projectId: string
  path?: string

  constructor(props: RepoProps) {
    this.name = props.name
    this.projectId = props.projectId
    this.path = props.path
  }
}
