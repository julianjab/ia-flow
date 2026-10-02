import type { GithubClient } from '@ia-flow/github-api'
import type { BoardCard, BoardMeta, BoardWriter } from '@ia-flow/github-tools'
import type { Board } from './Board.js'

/** Lo que la bandeja pide de un board, por proyecto (`BoardSpec.projectId`). */
export interface InboxBoards {
  cards(spec: { projectId: string }): Promise<BoardCard[]>
  meta(spec: { projectId: string }): Promise<BoardMeta>
}

/** El board de cada proyecto del runner. */
export class Boards implements InboxBoards {
  private readonly byProject: Map<string, Board>

  constructor(boards: Board[]) {
    this.byProject = new Map(boards.map((board) => [board.projectId, board]))
  }

  /** El board de un proyecto; uno que el runner no monta es un error de quien lo pide. */
  of(projectId: string): Board {
    const board = this.byProject.get(projectId)
    if (!board) throw new Error(`el proyecto "${projectId}" no tiene board`)
    return board
  }

  all(): Board[] {
    return [...this.byProject.values()]
  }

  /** Suelta el cache de las cards de todos: lo próximo que se pida se relee. */
  invalidate(): void {
    for (const board of this.byProject.values()) board.invalidate()
  }

  cards(spec: { projectId: string }): Promise<BoardCard[]> {
    return this.of(spec.projectId).cards()
  }

  meta(spec: { projectId: string }): Promise<BoardMeta> {
    return this.of(spec.projectId).meta()
  }

  /** Para escribir con otra identidad (la de la persona que usa la bandeja). `undefined` si el
   *  proyecto no tiene board: la acción que lo necesita falla con su propio mensaje. */
  writerFor(projectId: string, client: GithubClient): BoardWriter | undefined {
    return this.byProject.get(projectId)?.writerFor(client)
  }
}
