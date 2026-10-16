/**
 * Lo que una persona hace con el board en sí desde la bandeja: sumar un issue que todavía no está
 * y mover una card a otra columna. Va con el token de ESA persona —en el board queda a su nombre— y
 * sólo si puede escribir en el repo del issue. Mover una card es lo mismo que moverla en GitHub: el
 * webhook de ese cambio arranca el pipeline de la columna.
 */
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import type { AddToBoardRequest, AddToBoardResult, TaskActionResult } from '@ia-flow/shared'
import { createLogger } from '@ia-flow/telemetry'
import type { Board } from '../board/Board.js'
import type { BoardCard } from './classify.js'
import type { InboxService } from './InboxService.js'
import { assertCanPush, type IssueTarget, parseRef } from './pushAccess.js'
import { TaskActionError } from './TaskActionError.js'

export interface BoardMovesOptions {
  inbox: Pick<InboxService, 'card' | 'item'>
  /** El board de un proyecto (tira si el proyecto no tiene). */
  board(projectId: string): Pick<Board, 'meta' | 'writerFor' | 'adderFor' | 'holds' | 'describe'>
  /** Los proyectos del runner, en el orden de la config. */
  projects: string[]
  /** La columna donde entra un issue si no se dice otra (`inbox.statuses.todo`). */
  todo: string
  /** Después de un cambio: que la bandeja relea el board. */
  changed(ref: string): void
  fetchImpl?: typeof fetch
}

/** Quien pide el cambio: su token y su login de GitHub. */
export interface GithubActor {
  token: string
  login: string
}

const ISSUE_URL = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/

/** `owner/repo#n` o el link del issue → el issue. */
export function issueOf(input: string): IssueTarget {
  const text = input.trim()
  const url = ISSUE_URL.exec(text)
  if (url) return { owner: url[1] as string, repo: url[2] as string, number: Number(url[3]) }
  return parseRef(text)
}

const refOf = (issue: IssueTarget) => `${issue.owner}/${issue.repo}#${issue.number}`

export class BoardMoves {
  private readonly log = createLogger('runner.board-moves')

  constructor(private readonly options: BoardMovesOptions) {}

  private client(token: string): GithubClient {
    return new GithubClient({
      auth: new GithubTokenAuth(token),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    })
  }

  /** Que `status` sea una columna del board; un board que no declara columnas acepta cualquiera. */
  private async assertColumn(board: Pick<Board, 'meta' | 'describe'>, status: string) {
    const { statuses } = await board.meta()
    if (statuses.length > 0 && !statuses.includes(status)) {
      throw new TaskActionError(
        `"${status}" no es una columna de ${board.describe()}: ${statuses.join(', ')}`,
        400,
      )
    }
  }

  /** Mueve la card a `status`. No con un agente trabajando en ella: primero hay que detenerlo. */
  async move(ref: string, status: string, github: GithubActor): Promise<TaskActionResult> {
    const card: BoardCard | undefined = await this.options.inbox.card(ref)
    if (!card) throw new TaskActionError(`${ref} no está en ningún board de este runner`, 404)
    if (card.status === status) throw new TaskActionError(`${ref} ya está en ${status}`, 409)
    const board = this.options.board(card.projectId)
    await this.assertColumn(board, status)
    const live = (await this.options.inbox.item(ref))?.execution?.status
    if (live === 'running' || live === 'paused') {
      throw new TaskActionError(`${ref} tiene un agente corriendo: detenelo antes de moverla`, 409)
    }
    const client = this.client(github.token)
    const issue = parseRef(ref)
    await assertCanPush(client, issue, github.login)
    await board.writerFor(client).setFields(issue, { Status: status })
    const message = `movida de ${card.status ?? 'sin columna'} a ${status}`
    this.log.info(`${github.login}: ${ref} ${message}`, {
      'ia.issue': ref,
      'ia.github.login': github.login,
    })
    this.options.changed(ref)
    return { ok: true, message, github_login: github.login }
  }

  /** El proyecto al que va un issue: el pedido, o el único del runner. */
  private projectOf(projectId: string | undefined): string {
    const { projects } = this.options
    if (projectId) {
      if (!projects.includes(projectId)) {
        throw new TaskActionError(`"${projectId}" no es un proyecto de este runner`, 404)
      }
      return projectId
    }
    if (projects.length !== 1) {
      throw new TaskActionError(`¿a qué proyecto? Este runner tiene ${projects.join(', ')}`, 400)
    }
    return projects[0] as string
  }

  /**
   * Suma un issue abierto al board del proyecto, en `status` (o Todo). Un PR, un issue cerrado o
   * uno que ya está en el board no: el que ya está se mueve.
   */
  async add(request: AddToBoardRequest, github: GithubActor): Promise<AddToBoardResult> {
    const projectId = this.projectOf(request.project_id)
    const issue = issueOf(request.issue)
    const status = request.status?.trim() || this.options.todo
    const board = this.options.board(projectId)
    if (!board.holds(issue)) {
      throw new TaskActionError(
        `${issue.owner}/${issue.repo} no es parte de ${board.describe()}: agregá el repo al proyecto`,
        409,
      )
    }
    await this.assertColumn(board, status)
    const client = this.client(github.token)
    const res = await client.request(`/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`)
    if (!res.ok) {
      throw new TaskActionError(
        `GitHub no encontró ${refOf(issue)} con tu login (${res.status})`,
        res.status === 404 ? 404 : 502,
      )
    }
    const raw = (await res.json()) as {
      node_id: string
      html_url: string
      state: string
      pull_request?: unknown
    }
    if (raw.pull_request) {
      throw new TaskActionError(`${refOf(issue)} es un PR: se agrega su issue`, 400)
    }
    if (raw.state !== 'open') throw new TaskActionError(`${refOf(issue)} está cerrado`, 409)
    // El ref como lo escribe GitHub (mayúsculas incluidas): el mismo que traen las cards.
    const canonical = issueOf(raw.html_url)
    const ref = refOf(canonical)
    const existing = await this.options.inbox.card(ref)
    if (existing) {
      throw new TaskActionError(
        `${ref} ya está en el board${existing.status ? ` (${existing.status})` : ''}: movela`,
        409,
      )
    }
    await assertCanPush(client, canonical, github.login)
    await board.adderFor(client).addIssue(raw.node_id)
    await board.writerFor(client).setFields(canonical, { Status: status })
    this.log.info(`${github.login}: agregó ${ref} al board de ${projectId} en ${status}`, {
      'ia.issue': ref,
      'ia.github.login': github.login,
    })
    this.options.changed(ref)
    return {
      ok: true,
      message: `${ref} agregado en ${status}`,
      github_login: github.login,
      ref,
      status,
    }
  }
}
