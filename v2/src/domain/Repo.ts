export interface RepoProps {
  name: string
  githubOwner?: string
  githubRepo?: string
  workflow?: 'worktree' | 'branch' | 'main'
  slackReviewChannel?: string
  slackReviewers?: string[]
}

/** Coordenadas de un repo (no un path de disco — eso lo resuelve el provider vía prepareWorkspace). */
export class Repo {
  readonly name: string
  readonly githubOwner?: string
  readonly githubRepo?: string
  readonly workflow: 'worktree' | 'branch' | 'main'
  slackReviewChannel?: string
  slackReviewers: string[]

  constructor(props: RepoProps) {
    this.name = props.name
    this.githubOwner = props.githubOwner
    this.githubRepo = props.githubRepo
    this.workflow = props.workflow ?? 'worktree'
    this.slackReviewChannel = props.slackReviewChannel
    this.slackReviewers = props.slackReviewers ?? []
  }
}
