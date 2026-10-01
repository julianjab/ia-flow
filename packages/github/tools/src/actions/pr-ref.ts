/**
 * El PR sobre el que escribe o lee una tool: SIEMPRE el del evento, nunca uno que elija el modelo —
 * el que trae un evento de PR (`pr.*`), o si no el PR abierto de la task (`task.pr`, lo que arma
 * el intake para cualquier evento de la task: p. ej. la card que llega a Review).
 */
import type { PipelineExecutionContext } from '@ia-flow/agent-engine'

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
    task?: { pr?: { number?: number; headSha?: string } }
  }
  const { owner, repo, pr, task } = payload
  const number = pr?.head?.sha ? pr.number : task?.pr?.number
  const sha = pr?.head?.sha ?? task?.pr?.headSha
  if (!owner || !repo || typeof number !== 'number' || !sha) {
    throw new Error(
      'el evento no trae un PR (pr.number + pr.head.sha, o task.pr): esta tool sólo corre sobre un PR',
    )
  }
  return { owner, repo, number, sha }
}
