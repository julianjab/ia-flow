/**
 * El board de un proyecto: dónde vive el estado de sus tasks (la columna, el tipo, la marca "en
 * curso") y cómo se entera el runner de que cambió. Hay dos —los issues de un repo, con el estado
 * en labels, y un Project v2 de GitHub— y el resto del runner (la bandeja, el intake, las acciones)
 * sólo habla con esta interfaz.
 *
 * La elige `project.yaml` (`board:`). El engine no sabe que existe: ve los eventos que el intake
 * ya armó (`item.status`, `item.labels`, …).
 */
import type { GithubClient } from '@ia-flow/github-api'
import type {
  BoardAdder,
  BoardCard,
  BoardMeta,
  BoardWriter,
  IntakeBoard,
} from '@ia-flow/github-tools'
import type { Location } from '@ia-flow/github-webhook'

export type BoardKind = 'projects-v2' | 'issues'

/** Un webhook crudo (`github.<tipo>` sin el prefijo) → de qué task es y qué evento le toca. */
export type EventLocator = (type: string, raw: Record<string, unknown>) => Location

/** Cómo se identifica un board: `owner` + `number`. Un board de issues no tiene número: es 0. */
export interface BoardRef {
  owner: string
  number: number
  ownerKind?: 'orgs' | 'users'
}

/** Un webhook de GitHub armado a mano, para despacharlo por el intake como uno real. */
export interface RawDelivery {
  event: string
  id: string
  payload: Record<string, unknown>
}

/** Lo que la bandeja lee de un board. */
export interface BoardView {
  /** Las cards abiertas, ya con la forma de la bandeja (cache corto; `invalidate` lo suelta). */
  cards(): Promise<BoardCard[]>
  /** Sus links y el orden de sus columnas. */
  meta(): Promise<BoardMeta>
  invalidate(): void
}

/** Cómo un board se entera de lo que pasa en GitHub, y cómo lo simula. */
export interface BoardRouting {
  /** Cómo lee el intake la card de un issue. Sin esto, como un Project v2 (el default del intake,
   *  que comparte el cache por webhook de su `GithubTaskReader`). */
  readonly intake?: IntakeBoard
  /** Qué task y qué evento es un webhook crudo. Los de este board (un cambio de columna) más los
   *  que son iguales para todos (comentarios, PRs, CI). */
  locate: EventLocator
  /** El webhook que simula "la card llegó a `status`", hecho por `sender` (re-ejecutar un review).
   *  Tira si la card no se puede mover así. */
  statusChange(card: BoardCard, status: string, sender: string): RawDelivery
}

export interface Board extends BoardView, BoardRouting, BoardWriter, BoardAdder {
  readonly kind: BoardKind
  readonly projectId: string
  readonly ref: BoardRef
  /** Cómo se nombra en un log o en un estado: `la-haus#119`, o `issues de julianjab`. */
  describe(): string
  /** Escribir con otra identidad: las acciones de la bandeja actúan con el token de la persona. */
  writerFor(client: GithubClient): BoardWriter
}
