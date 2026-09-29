import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { issuePath } from '../shared.js'
import {
  type BranchResolver,
  branchFromPayload,
  type IssueRefResolver,
  issueFromPayload,
} from './issueRef.js'

/** Nada que decida el modelo: el issue y la rama salen del evento. */
export const LinkBranchInput = z.strictObject({})
export type LinkBranchInput = z.infer<typeof LinkBranchInput>

export interface LinkBranchActionOptions {
  client: GithubClient
  issue?: IssueRefResolver
  branch?: BranchResolver
  id?: string
}

interface IssueBranchesData {
  repository: {
    id: string
    defaultBranchRef: { target: { oid: string } | null } | null
    ref: { name: string } | null
    issue: {
      id: string
      linkedBranches: { nodes: Array<{ ref: { name: string } | null }> }
    } | null
  } | null
}

const BRANCHES_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $ref: String!) {
  repository(owner: $owner, name: $repo) {
    id
    defaultBranchRef { target { oid } }
    ref(qualifiedName: $ref) { name }
    issue(number: $number) {
      id
      linkedBranches(first: 50) { nodes { ref { name } } }
    }
  }
}`

const CREATE_LINKED_BRANCH = `mutation($issueId: ID!, $repositoryId: ID!, $oid: GitObjectID!, $name: String!) {
  createLinkedBranch(input: { issueId: $issueId, repositoryId: $repositoryId, oid: $oid, name: $name }) {
    linkedBranch { ref { name } }
  }
}`

/**
 * Vincula la rama de la task al issue — la sección "Development" del issue en GitHub, desde que
 * arranca el trabajo y no recién cuando hay PR. Es el `createLinkedBranch` del engine de ia-flow,
 * pero determinista: el nombre sale del evento (`task.branch`), no de un modelo.
 *
 * GitHub sólo vincula al CREAR la rama (`createLinkedBranch` la crea desde el HEAD de la default
 * branch). Por eso es idempotente y nunca pisa trabajo: si la rama ya está vinculada no hace
 * nada, y si ya existe en el remoto sin vínculo (una corrida anterior la subió) lo informa y sigue
 * — el vínculo en ese caso lo da el `Closes #n` del PR.
 */
export class LinkBranchAction extends Action<typeof LinkBranchInput> {
  readonly description = 'Vincula la rama de la task al issue (sección Development de GitHub).'
  readonly input = LinkBranchInput
  private readonly client: GithubClient
  private readonly resolveIssue: IssueRefResolver
  private readonly resolveBranch: BranchResolver

  constructor(options: LinkBranchActionOptions) {
    super({ id: options.id ?? 'link_branch' })
    this.client = options.client
    this.resolveIssue = options.issue ?? issueFromPayload
    this.resolveBranch = options.branch ?? branchFromPayload
  }

  async execute(_input: LinkBranchInput, ctx: PipelineExecutionContext): Promise<string> {
    const issue = this.resolveIssue(ctx)
    const branch = this.resolveBranch(ctx)
    issuePath(issue.owner, issue.repo, issue.number) // valida owner/repo/number antes de GraphQL
    const target = `${issue.owner}/${issue.repo}#${issue.number}`

    const data = await this.client.graphql<IssueBranchesData>(BRANCHES_QUERY, {
      owner: issue.owner,
      repo: issue.repo,
      number: issue.number,
      ref: `refs/heads/${branch}`,
    })
    const repository = data.repository
    if (!repository?.issue) throw new Error(`link_branch: ${target} no existe`)

    const linked = repository.issue.linkedBranches.nodes.some((node) => node.ref?.name === branch)
    if (linked) return `${target}: ${branch} ya estaba vinculada`
    if (repository.ref) {
      return `${target}: ${branch} ya existe en el remoto sin vínculo — GitHub sólo vincula al crear la rama; el PR la vincula con Closes #${issue.number}`
    }
    const oid = repository.defaultBranchRef?.target?.oid
    if (!oid) throw new Error(`link_branch: ${issue.owner}/${issue.repo} no tiene default branch`)

    await this.client.graphql(CREATE_LINKED_BRANCH, {
      issueId: repository.issue.id,
      repositoryId: repository.id,
      oid,
      name: branch,
    })
    return `${target}: ${branch} creada desde la default branch y vinculada al issue`
  }
}
