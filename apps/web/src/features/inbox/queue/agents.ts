// Los agentes de UNA ejecución. Un pipeline que corre agentes en paralelo (review: `reviewer` +
// `e2e-visual-qa`) es una sola ejecución, y su `agent_id` es sólo el del último que cerró: con
// `agents` se dibuja cada uno con su estado. Con uno solo (o un runner que no los manda), nada:
// queda el `agent_id` de siempre. Puro, sin Vue.

import type { ExecutionAgent, ExecutionSummary } from '@ia-flow/shared'

export type LaneState = ExecutionAgent['state']
/** El tono del glifo: `live` corre (--accent, con pulso), `ok` cerró bien, `warn` espera o lo
 *  interrumpieron, `bad` falló, `dim` quedó sin cerrar. */
export type LaneTone = 'live' | 'ok' | 'warn' | 'bad' | 'dim'

export interface AgentLane {
  id: string
  state: LaneState
  glyph: string
  tone: LaneTone
  /** El estado en palabras: para el lector de pantalla y el `title`. */
  label: string
  /** Sólo el que corre: cuánto hace de su último paso («hace 2 min»). */
  idle?: string
}

const LOOK: Record<LaneState, { glyph: string; tone: LaneTone; label: string }> = {
  running: { glyph: '●', tone: 'live', label: 'corriendo' },
  waiting: { glyph: '‖', tone: 'warn', label: 'esperando' },
  done: { glyph: '✓', tone: 'ok', label: 'terminó' },
  failed: { glyph: '✕', tone: 'bad', label: 'falló' },
  interrupted: { glyph: '○', tone: 'warn', label: 'interrumpido' },
  unfinished: { glyph: '○', tone: 'dim', label: 'sin cerrar' },
}

type WithAgents = { agents?: readonly ExecutionAgent[] } | null | undefined

/** «ahora», «hace 2 min», «hace 3 h»: lo que lleva quieto el que corre. */
export function idleText(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined
  const min = Math.floor(seconds / 60)
  if (min < 1) return 'ahora'
  if (min < 60) return `hace ${min} min`
  return `hace ${Math.floor(min / 60)} h`
}

/** Los agentes de la ejecución, si son MÁS de uno; si no, `[]` (se muestra como siempre). */
export function lanesOf(run: WithAgents): AgentLane[] {
  const agents = run?.agents ?? []
  if (agents.length < 2) return []
  return agents.map((agent) => {
    const look = LOOK[agent.state]
    const idle = agent.state === 'running' ? idleText(agent.idle_seconds) : undefined
    return { id: agent.agent_id, state: agent.state, ...look, ...(idle ? { idle } : {}) }
  })
}

/** El agente al que le toca la decisión: con varios, el único que espera o, si no, el único que
 *  falló; si no se puede decir cuál, el `agent_id` de la ejecución (el último que cerró). */
export function actingAgent(
  run: Pick<ExecutionSummary, 'agent_id' | 'agents'> | null | undefined,
): string | undefined {
  const agents = run?.agents ?? []
  if (agents.length > 1) {
    for (const state of ['waiting', 'failed'] as const) {
      const hits = agents.filter((a) => a.state === state)
      if (hits.length === 1) return hits[0]?.agent_id
    }
  }
  return run?.agent_id
}

/** Quién corre, en texto (`fmt.who` de un dashboard): `review → e2e-visual-qa` o, con varios en
 *  vuelo, `review → reviewer + e2e-visual-qa`. Sin `agents` (o uno solo), el `agent_id`. */
export function whoOf(run: Pick<ExecutionSummary, 'pipeline_id' | 'agent_id' | 'agents'>): string {
  const agents = run.agents ?? []
  const active = agents.filter((a) => a.state === 'running' || a.state === 'waiting')
  const names =
    agents.length > 1 && active.length > 0
      ? active.map((a) => a.agent_id).join(' + ')
      : run.agent_id
  return names ? `${run.pipeline_id} → ${names}` : run.pipeline_id
}
