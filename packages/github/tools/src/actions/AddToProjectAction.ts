import { Action } from '@ia-flow/agent-engine'
import { z } from 'zod'
import type { GithubProjectContext } from './repoCatalog.js'

const Input = z.strictObject({
  issue_node_id: z
    .string()
    .min(1)
    .describe('Node id del issue (el `issueId` de create_github_issue)'),
})

const PROJECT_ID = `query($owner: String!, $number: Int!) {
  organization(login: $owner) { projectV2(number: $number) { id } }
}`

const ADD_ITEM = `mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`

/** `add_to_project` de ia-flow: agrega un issue existente al board del proyecto. Queda sin
 *  Status — moverlo es decisión humana (ver el functional-refiner). */
export class AddToProjectAction extends Action<typeof Input> {
  readonly description =
    'Agrega un issue existente (por su node id) al board del proyecto. Devuelve el itemId.'
  readonly input = Input
  private projectId?: Promise<string>

  constructor(private readonly project: GithubProjectContext) {
    super({ id: 'add_to_project' })
  }

  async execute(input: z.infer<typeof Input>) {
    const data = await this.project.client.graphql<{
      addProjectV2ItemById?: { item?: { id: string } }
    }>(ADD_ITEM, {
      projectId: await this.resolveProjectId(),
      contentId: input.issue_node_id,
    })
    return JSON.stringify({ itemId: data.addProjectV2ItemById?.item?.id })
  }

  /** El node id del Project v2 — se pide una vez y se cachea (no cambia). */
  private resolveProjectId(): Promise<string> {
    this.projectId ??= this.project.client
      .graphql<{ organization?: { projectV2?: { id: string } } }>(PROJECT_ID, {
        owner: this.project.board.owner,
        number: this.project.board.number,
      })
      .then((data) => {
        const id = data.organization?.projectV2?.id
        if (!id)
          throw new Error(
            `no se encontró el board ${this.project.board.owner}#${this.project.board.number}`,
          )
        return id
      })
    this.projectId.catch(() => {
      this.projectId = undefined
    })
    return this.projectId
  }
}
