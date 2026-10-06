/**
 * Dónde quedan las mejoras que un agente propone fuera de una conversación (el de la
 * retrospectiva, en la pipeline de una tarea): nadie las está mirando cuando se proponen, así que
 * esperan en la bandeja hasta que una persona las abre como issue o las descarta.
 */
import type { ImprovementProposal, ImprovementStatus, ImprovementTarget } from '@ia-flow/shared'

export interface NewImprovement {
  task_ref: string
  pr_url?: string
  agent: string
  execution_id?: string
  target: ImprovementTarget
  repo: string
  title: string
  body: string
  labels?: string[]
  reason: string
}

export type ImprovementDecision =
  | { status: 'opened'; by: string; issue_url: string }
  | { status: 'dismissed'; by: string }

export interface ImprovementStore {
  add(input: NewImprovement): ImprovementProposal
  get(id: string): ImprovementProposal | undefined
  /** La más nueva primero; sin `status`, todas. */
  list(status?: ImprovementStatus, limit?: number): ImprovementProposal[]
  /** Una pendiente en `repo` con el mismo título (sin distinguir mayúsculas): no se repite. */
  findOpen(repo: string, title: string): ImprovementProposal | undefined
  /** Cierra una pendiente; `undefined` si no existe o ya estaba decidida. */
  decide(id: string, decision: ImprovementDecision): ImprovementProposal | undefined
  /** Borra las decididas antes de `cutoff` (ISO). Las pendientes quedan. */
  prune(cutoff: string): void
  /** Cada alta o decisión, en el momento. */
  onChange(listener: () => void): () => void
}
