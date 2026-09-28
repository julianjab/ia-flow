/**
 * El PR sobre el que escribe o lee una tool: SIEMPRE el del evento (`pr.*` del intake), nunca uno
 * que elija el modelo.
 */
import type { PipelineExecutionContext } from '@ia-tools/agent-pipeline'

export interface PrRef {
  owner: string
  repo: string
  number: number
  sha: string
}

/** El PR del evento: número y último commit, con el repo del payload. */
export function prFrom(ctx: PipelineExecutionContext): PrRef {
  const payload = ctx.event.payload as {
    owner?: string
    repo?: string
    pr?: { number?: number; head?: { sha?: string } }
  }
  const { owner, repo, pr } = payload
  if (!owner || !repo || typeof pr?.number !== 'number' || !pr.head?.sha) {
    throw new Error(
      'el evento no trae un PR (pr.number / pr.head.sha): esta tool sólo corre sobre un PR',
    )
  }
  return { owner, repo, number: pr.number, sha: pr.head.sha }
}
