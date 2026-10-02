import type { GithubClient } from '@ia-flow/github-api'
import type { BoardAdder, ProjectRef } from './types.js'

const PROJECT_ID = `query($owner: String!, $number: Int!) {
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { id } } }
}`

const ADD_ITEM = `mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`

/** Agrega issues existentes a un Project v2. El item queda sin Status: moverlo es decisión humana
 *  (ver el functional-refiner). El `ProjectV2Owner` cubre tanto una org como una cuenta personal. */
export class ProjectsV2Adder implements BoardAdder {
  private projectId?: Promise<string>

  constructor(
    private readonly client: GithubClient,
    private readonly board: ProjectRef,
  ) {}

  async addIssue(issueNodeId: string): Promise<{ itemId?: string }> {
    const data = await this.client.graphql<{
      addProjectV2ItemById?: { item?: { id: string } }
    }>(ADD_ITEM, {
      projectId: await this.resolveProjectId(),
      contentId: issueNodeId,
    })
    return { itemId: data.addProjectV2ItemById?.item?.id }
  }

  /** El node id del Project v2 — se pide una vez y se cachea (no cambia). */
  private resolveProjectId(): Promise<string> {
    this.projectId ??= this.client
      .graphql<{ repositoryOwner?: { projectV2?: { id: string } } }>(PROJECT_ID, {
        owner: this.board.owner,
        number: this.board.number,
      })
      .then((data) => {
        const id = data.repositoryOwner?.projectV2?.id
        if (!id) throw new Error(`no se encontró el board ${this.board.owner}#${this.board.number}`)
        return id
      })
    this.projectId.catch(() => {
      this.projectId = undefined
    })
    return this.projectId
  }
}
