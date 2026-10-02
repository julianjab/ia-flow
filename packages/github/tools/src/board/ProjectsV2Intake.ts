import type { GithubTaskReader } from '../task/GithubTaskReader.js'
import { boardItem, type Card } from '../task/shapes.js'
import type { IntakeBoard, IssueRef, ItemLookup, ProjectRef } from './types.js'

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Lo que el intake lee de un Project v2: la card de un issue (entre los boards donde está) y el
 * issue detrás de un item. Recibe el `GithubTaskReader` ya armado —con o sin su cache por
 * webhook— para que quien lo use decida cuánto se comparte entre proyectos.
 */
export class ProjectsV2Intake implements IntakeBoard {
  constructor(
    private readonly reader: GithubTaskReader,
    private readonly board: ProjectRef,
  ) {}

  async cardOf(issue: IssueRef): Promise<Card | undefined> {
    return boardItem(
      await this.reader.itemsOfIssue(issue.owner, issue.repo, issue.number),
      this.board,
    )
  }

  async issueOfItem(itemId: string): Promise<ItemLookup> {
    const found = await this.reader.issueOfItem(itemId)
    if (!found) return { skipped: `no se pudo leer el item ${itemId}` }
    const { board } = this
    if (found.board.number !== board.number || !same(found.board.owner, board.owner)) {
      return { skipped: `item del board ${found.board.owner}#${found.board.number}` }
    }
    return { issue: { owner: found.owner, repo: found.repo, number: found.number } }
  }
}
