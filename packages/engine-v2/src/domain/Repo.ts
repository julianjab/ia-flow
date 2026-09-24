export interface RepoProps {
  name: string
  projectId: string
  path?: string
}

/** Fuente en vivo inyectada — un `Repo` nunca se cachea en memoria. */
export interface RepoSource {
  get(projectId: string, name: string): RepoRow | undefined
}

/**
 * Un path con nombre, nada más. `githubOwner`/`githubRepo`/`slackReview*`
 * vivían acá antes — se borraron: son propiedades de un generador
 * (GitHub/Slack) coladas en una entidad que el engine tiene que poder usar
 * sin saber qué generador existe del otro lado. `path` es lo único que
 * `ScriptAction` necesita para resolver un `cwd`.
 *
 * `resolve()` pega contra el `RepoSource` inyectado en CADA llamada — sin
 * caché, mismo criterio que `Agent.resolve`/`Project.resolve`. Inyectar es
 * EL mecanismo, también en tests.
 */
export class Repo {
  private static source?: RepoSource

  static setSource(source: RepoSource): void {
    Repo.source = source
  }

  static resolve(projectId: string, name: string): Repo | undefined {
    if (Repo.source == null) throw new Error('Repo: falta inyectar un RepoSource (ver Repo.setSource)')
    const row = Repo.source.get(projectId, name)
    return row == null ? undefined : Repo.fromRow(row)
  }

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
