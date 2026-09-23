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

/** Coordenadas de un repo (no un path de disco fijo — `path` es un override;
 *  lo normal es que el provider lo resuelva vía prepareWorkspace). */
export class Repo {
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
