import { Action } from '@ia-flow/agent-engine'
import { z } from 'zod'
import type { GithubProjectContext } from './repoCatalog.js'

const Input = z.strictObject({
  blocked_issue_id: z.string().min(1).describe('Node id del issue que queda bloqueado'),
  blocking_issue_id: z.string().min(1).describe('Node id del issue que bloquea (el prerrequisito)'),
})

const ADD_BLOCKED_BY = `mutation($issueId: ID!, $blockingIssueId: ID!) {
  addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { issue { id } }
}`

/**
 * `mark_blocked_by` de ia-flow: la dependencia nativa de GitHub entre dos issues. Es lo que lee
 * el gate de blockers del intake (`item.blocked`): un agente sin `allowBlocked` no corre sobre
 * una card con prerrequisitos abiertos.
 */
export class MarkBlockedByAction extends Action<typeof Input> {
  readonly description =
    'Marca que un issue está bloqueado por otro (su prerrequisito). Los ids son node ids (el `issueId` de create_github_issue).'
  readonly input = Input

  constructor(private readonly project: GithubProjectContext) {
    super({ id: 'mark_blocked_by' })
  }

  async execute(input: z.infer<typeof Input>) {
    await this.project.client.graphql(ADD_BLOCKED_BY, {
      issueId: input.blocked_issue_id,
      blockingIssueId: input.blocking_issue_id,
    })
    return `Dependencia creada: ${input.blocked_issue_id} bloqueado por ${input.blocking_issue_id}`
  }
}
