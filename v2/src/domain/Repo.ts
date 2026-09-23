import { Catalog } from '../shared/Catalog.js'

export interface SlackMemberRef {
  id: string
  name?: string
}

export interface RepoProps {
  name: string
  projectId: string
  path?: string
  githubOwner?: string
  githubRepo?: string
  workflow?: 'worktree' | 'branch' | 'main'
  description?: string
  slackReviewChannel?: string
  slackReviewers?: SlackMemberRef[]
}

/**
 * Coordenadas de un repo (no un path de disco fijo — `path` es un override;
 * lo normal es que el provider lo resuelva vía prepareWorkspace). Se
 * autoindexa como el resto del dominio — clave compuesta `projectId:name`
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
  readonly githubOwner?: string
  readonly githubRepo?: string
  readonly workflow: 'worktree' | 'branch' | 'main'
  description?: string
  slackReviewChannel?: string
  slackReviewers: SlackMemberRef[]

  constructor(props: RepoProps) {
    this.name = props.name
    this.projectId = props.projectId
    this.path = props.path
    this.githubOwner = props.githubOwner
    this.githubRepo = props.githubRepo
    this.workflow = props.workflow ?? 'worktree'
    this.description = props.description
    this.slackReviewChannel = props.slackReviewChannel
    this.slackReviewers = props.slackReviewers ?? []
  }
}
