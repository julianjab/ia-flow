// «Lo último que corrió»: las corridas que ya cerraron, de la más nueva a la más vieja, para que el
// estado del pipeline no se quede en «0 corriendo» cuando hace media hora terminó algo. Sale de la
// última corrida de cada card (`last_run` de `/api/tasks` o, con un runner viejo, la `execution`
// cerrada de un item): una por tarea. Puro: `now` se inyecta.

import type { ExecutionSummary } from '@ia-flow/shared'
import { type Age, ageOf } from '@/features/inbox/queue/age'
import { shortRef } from '@/features/inbox/queue/shortRef'

/** Cuántas se listan: es un vistazo, no el historial (ése vive en el detalle de cada tarea). */
export const RECENT_LIMIT = 5

export type ClosedStatus = 'done' | 'failed' | 'superseded'

export interface RecentRun {
  ref: string
  short: string
  url: string
  title: string
  /** El agente que cerró (o la pipeline, si corrieron varios en paralelo). */
  agent: string
  status: ClosedStatus
  /** La salida por la que terminó, si no es la de siempre (`done`). */
  exit?: string
  /** Cuánto hace que cerró. */
  age: Age
}

/** Una card con su última corrida, venga de donde venga. */
export interface RunSource {
  ref: string
  title: string
  url: string
  run?: ExecutionSummary
}

const CLOSED = new Set<string>(['done', 'failed', 'superseded'])

function agentOf(run: ExecutionSummary): string {
  if ((run.agents?.length ?? 0) > 1) return run.pipeline_id
  return run.agent_id ?? run.pipeline_id
}

export function recentOf(
  sources: readonly RunSource[],
  now: number,
  limit = RECENT_LIMIT,
): RecentRun[] {
  const seen = new Set<string>()
  return sources
    .filter((s) => s.run?.closed_at && CLOSED.has(s.run.status))
    .sort((a, b) => Date.parse(b.run?.closed_at ?? '') - Date.parse(a.run?.closed_at ?? ''))
    .filter((s) => !seen.has(s.ref) && seen.add(s.ref))
    .slice(0, limit)
    .map(({ ref, title, url, run }) => {
      const closed = run as ExecutionSummary
      return {
        ref,
        short: shortRef(ref),
        url,
        title,
        agent: agentOf(closed),
        status: closed.status as ClosedStatus,
        ...(closed.exit && closed.exit !== 'done' ? { exit: closed.exit } : {}),
        age: ageOf(closed.closed_at as string, now),
      }
    })
}
