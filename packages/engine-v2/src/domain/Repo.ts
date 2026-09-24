export interface RepoProps {
  name: string
  projectId: string
  path?: string
}

/**
 * Port: de dónde sale un `Repo`, en vivo. Inyectado por constructor en el
 * `Engine` (`EngineSources`), nunca conocido por `Repo`. El adapter es dueño
 * de traducir su fila con `Repo.fromRow`.
 */
export interface RepoSource {
  get(projectId: string, name: string): Repo | undefined
}

/**
 * Un path con nombre, nada más. `githubOwner`/`githubRepo`/`slackReview*`
 * vivían acá antes — se borraron: son propiedades de un generador
 * (GitHub/Slack) coladas en una entidad que el engine tiene que poder usar
 * sin saber qué generador existe del otro lado. `path` es lo único que
 * `ScriptAction` necesita para resolver un `cwd`.
 *
 * Entidad pura: buscarla es trabajo de un `RepoSource`, consultado en CADA
 * dispatch sin caché — mismo criterio que `Project`/`Agent`.
 */
export class Repo {
  readonly name: string
  readonly projectId: string
  path?: string

  constructor(props: RepoProps) {
    this.name = props.name
    this.projectId = props.projectId
    this.path = props.path
  }

  /** `DbRepoEntry` (v1, `@ia-flow/agent-engine`) trae `name`/`projectId`/
   *  `path` con los mismos nombres — el resto de sus campos
   *  (`githubOwner`/`githubRepo`/`workflow`/Slack) es lo que el purge de
   *  agnosticismo ya sacó de esta clase, así que se ignoran acá también. */
  static fromRow(row: RepoRow): Repo {
    return new Repo({ name: row.name, projectId: row.projectId, path: row.path })
  }
}

export type RepoRow = RepoProps
