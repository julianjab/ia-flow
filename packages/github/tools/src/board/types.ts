/**
 * Lo que el resto del sistema necesita de "un board", partido por rol: cada consumidor recibe el
 * rol que usa, no un board entero. Un board es de un Project v2 de GitHub o de los issues de un
 * repo (el estado vive en labels); estas interfaces son lo único que ven la bandeja, el intake y
 * las acciones.
 *
 * Los tipos viven acá y no en el runner porque los implementan las dos cosas (las acciones de este
 * paquete y los boards del runner) y un paquete nunca importa de `apps/`.
 */
import type { IssueRef } from '../actions/issueRef.js'
import type { Card } from '../task/shapes.js'

export type { IssueRef }

/** El Project v2 donde viven los campos (`Status`, `Task Type`, ...). */
export interface ProjectRef {
  /** Login de la organización o usuario dueño del proyecto. */
  owner: string
  number: number
}

/** Lo que la bandeja necesita de una card del board. */
export interface BoardCard {
  /** `owner/repo#n` */
  ref: string
  /** El id del item en el board (`PVTI_…`): con él se simula un cambio de Status. Un board que no
   *  tiene items (el de issues) no lo trae. */
  itemId?: string
  projectId: string
  title: string
  url: string
  status?: string
  taskType?: string
  labels: string[]
  /** La última vez que la card cambió (ISO). */
  updatedAt: string
  /** Los issues abiertos que la bloquean (`owner/repo#n`). */
  blockedBy: string[]
  pr?: { number: number; url: string }
  /** La épica: el issue padre y cuántos de sus sub-issues cerraron. Sin padre (o un board que no
   *  sabe leerlo), ausente. */
  epic?: BoardEpic
}

/** El issue padre de una card y su avance. */
export interface BoardEpic {
  /** `owner/repo#n` */
  ref: string
  title: string
  /** Sub-issues cerrados. */
  done: number
  total: number
}

/** Lo que se sabe del board en sí: sus links y el orden de sus columnas. */
export interface BoardMeta {
  url: string
  boardUrl: string
  /** Las opciones del campo Status, en el orden del board. */
  statuses: string[]
}

/** Escribir los campos de la card de un issue: la columna (`Status`), el tipo, la marca "en curso". */
export interface BoardWriter {
  /**
   * Pone `set` (`{ Status: 'Build', 'Task Type': 'Functional' }`) y vacía `clear` (por nombre de
   * campo). Tira si el issue no está en el board, o si el campo o su valor no existen: un fallo
   * acá corta antes de tocar labels o estado.
   */
  setFields(issue: IssueRef, set: Record<string, string>, clear?: string[]): Promise<void>
}

/** Que un issue pase a ser parte del board. */
export interface BoardAdder {
  /** `issueNodeId` es el node id de GraphQL del issue (el `issueId` de `create_github_issue`). */
  addIssue(issueNodeId: string): Promise<{ itemId?: string }>
}

/** Lo que el intake lee del board para publicar la task de un webhook. */
export type ItemLookup = { issue: IssueRef } | { skipped: string }

export interface IntakeBoard {
  /** La card de UN issue en este board, o `undefined` si el issue no está en él. */
  cardOf(issue: IssueRef): Promise<Card | undefined>
  /** El issue detrás del id de un item del board (el de un webhook `projects_v2_item`). Con el
   *  motivo si no es de este board. */
  issueOfItem(itemId: string): Promise<ItemLookup>
}
