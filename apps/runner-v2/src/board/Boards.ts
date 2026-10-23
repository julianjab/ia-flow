import type { GithubClient } from '@ia-flow/github-api'
import type { BoardCard, BoardMeta, BoardWriter } from '@ia-flow/github-tools'
import type { ClosedCard } from '../inbox/ClosedCards.js'
import type { Board } from './Board.js'
import { RefreshingCache } from './RefreshingCache.js'

/** Cuánto vale la bandeja sin un webhook que la marque vieja (y entonces se relee igual, sin
 *  frenar a quien pide). */
const CARDS_TTL_MS = 60_000

/** Las refs cuya card cambió (o apareció, o se fue) entre dos lecturas. */
export function changedRefs(previous: BoardCard[], next: BoardCard[]): string[] {
  const before = new Map(previous.map((card) => [card.ref, JSON.stringify(card)]))
  const after = new Map(next.map((card) => [card.ref, JSON.stringify(card)]))
  const refs = new Set<string>()
  for (const [ref, card] of after) if (before.get(ref) !== card) refs.add(ref)
  for (const ref of before.keys()) if (!after.has(ref)) refs.add(ref)
  return [...refs]
}

/** Lo que la bandeja pide de un board, por proyecto (`BoardSpec.projectId`). */
export interface InboxBoards {
  cards(spec: { projectId: string }): Promise<BoardCard[]>
  meta(spec: { projectId: string }): Promise<BoardMeta>
  closed(spec: { projectId: string }): Promise<ClosedCard[]>
}

/** El board de cada proyecto del runner. */
export class Boards implements InboxBoards {
  private readonly byProject: Map<string, Board>
  /** Lo que lee la bandeja (`cards`): se sirve viejo mientras se relee (ver RefreshingCache). Los
   *  que necesitan el dato real (el intake, revalidar una task) van directo a `of(…).cards()`. */
  private readonly caches = new Map<string, RefreshingCache<BoardCard[]>>()
  private readonly listeners = new Set<(refs: string[]) => void>()

  constructor(
    boards: Board[],
    private readonly options: { now?: () => number; onError?: (error: unknown) => void } = {},
  ) {
    this.byProject = new Map(boards.map((board) => [board.projectId, board]))
  }

  private cache(projectId: string): RefreshingCache<BoardCard[]> {
    let cache = this.caches.get(projectId)
    if (!cache) {
      const board = this.of(projectId)
      cache = new RefreshingCache(
        () => {
          // La relectura es de verdad: sin el cache corto del propio board.
          board.invalidate()
          return board.cards()
        },
        {
          ttlMs: CARDS_TTL_MS,
          ...(this.options.now ? { now: this.options.now } : {}),
          ...(this.options.onError ? { onError: this.options.onError } : {}),
          onRefreshed: (previous, next) => {
            if (!previous) return
            const refs = changedRefs(previous, next)
            if (refs.length > 0) for (const listener of this.listeners) listener(refs)
          },
        },
      )
      this.caches.set(projectId, cache)
    }
    return cache
  }

  /** Cuando una relectura de la bandeja trae cards distintas: las refs que cambiaron. */
  onCardsChanged(listener: (refs: string[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Un webhook: lo que sirve la bandeja está viejo, pero nadie espera — se relee en segundo
   *  plano y, si cambió algo, avisa (`onCardsChanged`). */
  markStale(): void {
    for (const cache of this.caches.values()) cache.markStale()
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

  /** Suelta el cache de las cards de todos: lo próximo que se pida espera una lectura nueva. */
  invalidate(): void {
    for (const board of this.byProject.values()) board.invalidate()
    for (const cache of this.caches.values()) cache.invalidate()
  }

  cards(spec: { projectId: string }): Promise<BoardCard[]> {
    return this.cache(spec.projectId).get()
  }

  meta(spec: { projectId: string }): Promise<BoardMeta> {
    return this.of(spec.projectId).meta()
  }

  /** Las cerradas de ese board; uno que no las sabe leer (el de labels), ninguna. */
  closed(spec: { projectId: string }): Promise<ClosedCard[]> {
    return this.of(spec.projectId).closed?.() ?? Promise.resolve([])
  }

  /** Para escribir con otra identidad (la de la persona que usa la bandeja). `undefined` si el
   *  proyecto no tiene board: la acción que lo necesita falla con su propio mensaje. */
  writerFor(projectId: string, client: GithubClient): BoardWriter | undefined {
    return this.byProject.get(projectId)?.writerFor(client)
  }
}
