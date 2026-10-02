import { Action } from '@ia-flow/agent-engine'
import { z } from 'zod'
import { ProjectsV2Adder } from '../board/ProjectsV2Adder.js'
import type { BoardAdder } from '../board/types.js'
import type { GithubProjectContext } from './repoCatalog.js'

const Input = z.strictObject({
  issue_node_id: z
    .string()
    .min(1)
    .describe('Node id del issue (el `issueId` de create_github_issue)'),
})

/** `add_to_project` de ia-flow: agrega un issue existente al board del proyecto. Queda sin
 *  Status — moverlo es decisión humana (ver el functional-refiner). */
export class AddToProjectAction extends Action<typeof Input> {
  readonly description =
    'Agrega un issue existente (por su node id) al board del proyecto. Devuelve el itemId.'
  readonly input = Input
  private readonly adder: BoardAdder

  constructor(project: GithubProjectContext) {
    super({ id: 'add_to_project' })
    this.adder = project.adder ?? new ProjectsV2Adder(project.client, project.board)
  }

  async execute(input: z.infer<typeof Input>) {
    return JSON.stringify(await this.adder.addIssue(input.issue_node_id))
  }
}
