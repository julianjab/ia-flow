import { Action } from '@ia-flow/agent-engine'
import { z } from 'zod'
import type { GithubProjectContext } from './repoCatalog.js'

const Input = z.strictObject({
  blocked_issue_id: z.string().min(1).describe('Node id del issue que deja de estar bloqueado'),
  blocking_issue_id: z.string().min(1).describe('Node id del issue que ya no es su prerrequisito'),
})

const REMOVE_BLOCKED_BY = `mutation($issueId: ID!, $blockingIssueId: ID!) {
  removeBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { issue { id } }
}`

/**
 * `remove_blocked_by` de ia-flow: deshace un `mark_blocked_by`. Es lo que necesita quien re-planea
 * una épica cuando un cambio de alcance hace que un hijo ya no dependa de otro.
 */
export class RemoveBlockedByAction extends Action<typeof Input> {
  readonly description =
    'Quita la dependencia entre dos issues (deshace mark_blocked_by). Los ids son node ids.'
  readonly input = Input

  constructor(private readonly project: GithubProjectContext) {
    super({ id: 'remove_blocked_by' })
  }

  async execute(input: z.infer<typeof Input>) {
    await this.project.client.graphql(REMOVE_BLOCKED_BY, {
      issueId: input.blocked_issue_id,
      blockingIssueId: input.blocking_issue_id,
    })
    return `Dependencia quitada: ${input.blocked_issue_id} ya no está bloqueado por ${input.blocking_issue_id}`
  }
}
