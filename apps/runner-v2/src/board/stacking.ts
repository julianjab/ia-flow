/**
 * Los blockers de una card que todavía frenan, con `stacking` en el proyecto: una task con su label
 * avanza sobre prerrequisitos construidos, así que un blocker que ya tiene PR abierto deja de
 * contar —como hace el intake con `item.blocked`—. Lo que lee `blockedBy` (revalidar una task que
 * esperó turno, la bandeja, la vista de la épica) ve lo mismo que las pipelines.
 *
 * Mira sólo el board: un blocker que no está en él sigue frenando. Que los del mismo repo formen
 * una cadena lo decide el intake al publicar (`stackOf`), no esto.
 */
import type { BoardCard } from '@ia-flow/github-tools'

export function withBuiltBlockers(cards: BoardCard[], label: string | undefined): BoardCard[] {
  if (!label) return cards
  const built = new Set(cards.filter((card) => card.pr).map((card) => card.ref))
  return cards.map((card) =>
    card.labels.includes(label) && card.blockedBy.some((ref) => built.has(ref))
      ? { ...card, blockedBy: card.blockedBy.filter((ref) => !built.has(ref)) }
      : card,
  )
}
