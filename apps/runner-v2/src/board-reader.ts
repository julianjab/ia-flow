/**
 * Lecturas del board (Project v2) que el servidor de webhooks necesita y la CLI no: la CLI recibe
 * `--status`/`--type` del operador, un delivery de GitHub no trae ninguno de los dos. Es lo que en
 * ia-flow hace `resolveItem` (`getItemById`/`getItemByIssueId`): UNA query puntual por delivery,
 * nunca un scan del board.
 */
import type { GithubClient } from '@ia-tools/github-api'

export interface BoardRef {
  owner: string
  number: number
}

/** Lo que las reglas leen del board: `item.status` e `item.type`. */
export interface BoardItem {
  /** Node id del `ProjectV2Item` — la clave con la que se recuerda el último status visto. */
  itemId: string
  board: BoardRef
  status?: string
  /** `functional` | `technical` — el campo `Task Type` en minúsculas, como lo esperan las reglas. */
  type: string
}

export interface BoardIssue extends BoardItem {
  owner: string
  repo: string
  number: number
}

/** El puerto que usa el traductor — una interfaz para poder testearlo sin GraphQL. */
export interface BoardReader {
  /** El item de `owner/repo#number` en `board`; `undefined` si el issue no está en ese board. */
  itemForIssue(
    board: BoardRef,
    owner: string,
    repo: string,
    number: number,
  ): Promise<BoardItem | undefined>
  /** El issue detrás de un `ProjectV2Item`; `undefined` si el item no envuelve un issue. */
  issueForItem(itemId: string): Promise<BoardIssue | undefined>
}

const FIELD_VALUES = `fieldValues(first: 30) {
  nodes {
    ... on ProjectV2ItemFieldSingleSelectValue {
      name
      field { ... on ProjectV2SingleSelectField { name } }
    }
  }
}`

const PROJECT = 'project { number owner { ... on Organization { login } ... on User { login } } }'

const ITEM_FOR_ISSUE = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      projectItems(first: 50) { nodes { id ${PROJECT} ${FIELD_VALUES} } }
    }
  }
}`

const ISSUE_FOR_ITEM = `query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2Item {
      id
      ${PROJECT}
      content { ... on Issue { number repository { name owner { login } } } }
      ${FIELD_VALUES}
    }
  }
}`

interface RawItem {
  id: string
  project: { number: number; owner: { login?: string } }
  fieldValues: { nodes: Array<{ name?: string; field?: { name?: string } }> }
}

interface ItemForIssueData {
  repository: { issue: { projectItems: { nodes: RawItem[] } } | null } | null
}

interface IssueForItemData {
  node:
    | (RawItem & {
        content: {
          number?: number
          repository?: { name: string; owner: { login: string } }
        } | null
      })
    | null
}

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase()

function toItem(raw: RawItem): BoardItem {
  const field = (name: string) =>
    raw.fieldValues.nodes.find((value) => same(value.field?.name, name))?.name
  return {
    itemId: raw.id,
    board: { owner: raw.project.owner.login ?? '', number: raw.project.number },
    status: field('Status'),
    // Sin `Task Type` en el board, la card es técnica — mismo default que `--type` en la CLI.
    type: (field('Task Type') ?? 'technical').toLowerCase(),
  }
}

export class GraphqlBoardReader implements BoardReader {
  constructor(private readonly client: GithubClient) {}

  async itemForIssue(board: BoardRef, owner: string, repo: string, number: number) {
    const data = await this.client.graphql<ItemForIssueData>(ITEM_FOR_ISSUE, {
      owner,
      repo,
      number,
    })
    const raw = data.repository?.issue?.projectItems.nodes.find(
      (item) => item.project.number === board.number && same(item.project.owner.login, board.owner),
    )
    return raw ? toItem(raw) : undefined
  }

  async issueForItem(itemId: string) {
    const { node } = await this.client.graphql<IssueForItemData>(ISSUE_FOR_ITEM, { id: itemId })
    const repository = node?.content?.repository
    if (!node || !repository || typeof node.content?.number !== 'number') return undefined
    return {
      ...toItem(node),
      owner: repository.owner.login,
      repo: repository.name,
      number: node.content.number,
    }
  }
}
