import { Action } from '@ia-flow/agent-engine'
import { z } from 'zod'
import { ProjectsV2Adder } from '../board/ProjectsV2Adder.js'
import type { BoardAdder, BoardWriter } from '../board/types.js'
import type { IssueRef } from './issueRef.js'
import type { GithubProjectContext } from './repoCatalog.js'

const Input = z.strictObject({
  issue_node_id: z
    .string()
    .min(1)
    .describe('Node id del issue (el `issueId` de create_github_issue)'),
  /** La columna en la que entra. Sin esto queda sin Status. Un agente la recibe fijada en su YAML
   *  (`with: { status: Refine }`), no la elige. */
  status: z.string().min(1).optional(),
})

const ISSUE_OF_NODE = `query($id: ID!) {
  node(id: $id) { ... on Issue { number repository { name owner { login } } } }
}`

/** `add_to_project` de ia-flow: agrega un issue existente al board del proyecto, sin Status o en
 *  la columna que diga `status` (ver el functional-refiner). */
export class AddToProjectAction extends Action<typeof Input> {
  readonly description =
    'Agrega un issue existente (por su node id) al board del proyecto. Devuelve el itemId.'
  readonly input = Input
  private readonly adder: BoardAdder

  constructor(private readonly project: GithubProjectContext & { writer?: BoardWriter }) {
    super({ id: 'add_to_project' })
    this.adder = project.adder ?? new ProjectsV2Adder(project.client, project.board)
  }

  async execute(input: z.infer<typeof Input>) {
    const added = await this.adder.addIssue(input.issue_node_id)
    if (!input.status) return JSON.stringify(added)
    const { writer } = this.project
    if (!writer) throw new Error('add_to_project: `status` necesita el board del proyecto')
    await writer.setFields(await this.issueOf(input.issue_node_id), { Status: input.status })
    return JSON.stringify({ ...added, status: input.status })
  }

  /** `owner/repo#n` del issue detrás de un node id: lo que el board necesita para mover la card. */
  private async issueOf(nodeId: string): Promise<IssueRef> {
    const data = await this.project.client.graphql<{
      node?: { number?: number; repository?: { name: string; owner: { login: string } } } | null
    }>(ISSUE_OF_NODE, { id: nodeId })
    const node = data.node
    if (!node?.number || !node.repository) {
      throw new Error(`add_to_project: ${nodeId} no es un issue`)
    }
    return { owner: node.repository.owner.login, repo: node.repository.name, number: node.number }
  }
}
