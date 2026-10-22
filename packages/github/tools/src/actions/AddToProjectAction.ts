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
   *  (`with: { status: Refine }`), no la elige. Una card que ya tenía columna no se mueve. */
  status: z.string().min(1).optional(),
  /** Labels que se le suman al issue al entrar al board (`with: { labels: [epic-hold] }`, fijados
   *  en el YAML). A uno que ya tenía columna no se le tocan. */
  labels: z.array(z.string().min(1)).optional(),
})

const ISSUE_OF_NODE = `query($id: ID!) {
  node(id: $id) { ... on Issue { number repository { name owner { login } } } }
}`

/** `add_to_project` de ia-flow: agrega un issue existente al board del proyecto, sin Status o en
 *  la columna que diga `status`, con `labels` (ver el functional-refiner). Llamarla sobre un issue
 *  que YA tiene columna no lo mueve ni le toca los labels: así un agente puede pasar todos los hijos
 *  de una épica sin devolver a Refine uno que ya está en Build. */
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
    // Ya estaba en el board con su columna: se deja como está.
    if (added.status) return JSON.stringify({ ...added, alreadyOnBoard: true })
    if (!input.status && !input.labels?.length) return JSON.stringify(added)
    const { writer } = this.project
    if (input.status && !writer) {
      throw new Error('add_to_project: `status` necesita el board del proyecto')
    }
    const issue = await this.issueOf(input.issue_node_id)
    if (input.labels?.length) {
      await this.project.client.requestJson(
        `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}/labels`,
        { method: 'POST', body: JSON.stringify({ labels: input.labels }) },
      )
    }
    if (!input.status || !writer) return JSON.stringify({ ...added, labels: input.labels })
    await writer.setFields(issue, { Status: input.status })
    return JSON.stringify({
      ...added,
      status: input.status,
      ...(input.labels?.length ? { labels: input.labels } : {}),
    })
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
