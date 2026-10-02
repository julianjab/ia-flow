import type { GithubClient } from '@ia-flow/github-api'
import {
  type BoardCard,
  type BoardMeta,
  type BoardWriter,
  ProjectsV2Adder,
  ProjectsV2Fields,
} from '@ia-flow/github-tools'
import { locate } from '@ia-flow/github-webhook'
import type { BoardReader } from '../inbox/BoardReader.js'
import { statusChangeWebhook } from '../inbox/statusChangeWebhook.js'
import type { Board, BoardRef, EventLocator, RawDelivery } from './Board.js'

/**
 * El board de un GitHub Project v2: el estado es el campo `Status` de la card (y los demás campos
 * single-select, como `Task Type` o la marca "Working"). Envuelve lo que el runner ya tenía —la
 * lectura de la bandeja, la escritura de campos, el agregado de issues— sin cambiar nada de eso.
 *
 * Es el único que recibe `projects_v2_item`: GitHub no lo emite para un Project de una cuenta
 * personal, así que ahí no llegan cambios de columna (ver `IssuesBoard`).
 */
export class ProjectsV2Board implements Board {
  readonly kind = 'projects-v2' as const
  private readonly fields: ProjectsV2Fields
  private readonly adder: ProjectsV2Adder

  constructor(
    readonly projectId: string,
    readonly ref: BoardRef,
    private readonly client: GithubClient,
    private readonly reader: BoardReader,
  ) {
    this.fields = new ProjectsV2Fields(client, ref)
    this.adder = new ProjectsV2Adder(client, ref)
  }

  cards(): Promise<BoardCard[]> {
    return this.reader.cards({ projectId: this.projectId, board: this.ref })
  }

  meta(): Promise<BoardMeta> {
    return this.reader.meta({ projectId: this.projectId, board: this.ref })
  }

  invalidate(): void {
    this.reader.invalidate()
  }

  setFields(...args: Parameters<BoardWriter['setFields']>): Promise<void> {
    return this.fields.setFields(...args)
  }

  addIssue(issueNodeId: string): Promise<{ itemId?: string }> {
    return this.adder.addIssue(issueNodeId)
  }

  /** El mapeo de siempre: `projects_v2_item` ya es un cambio de columna. */
  readonly locate: EventLocator = (type, raw) => locate(type, raw)

  statusChange(card: BoardCard, status: string, sender: string): RawDelivery {
    if (!card.itemId) throw new Error(`${card.ref} no está en el board`)
    return statusChangeWebhook({ itemId: card.itemId, status, sender })
  }

  writerFor(client: GithubClient): BoardWriter {
    return client === this.client ? this.fields : new ProjectsV2Fields(client, this.ref)
  }
}
