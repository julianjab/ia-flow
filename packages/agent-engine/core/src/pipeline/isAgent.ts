import type { Agent } from '../agent/Agent.js'
import type { Runnable } from './Runnable.js'

/** Type guard útil para quien construye pipelines dinámicamente desde config — distingue un
 *  paso respaldado por LLM de un `Runnable` genérico (Emit/Http/Function). Aparte de `Pipeline.ts`
 *  para que `tracing.ts` lo use sin un ciclo de imports. */
export function isAgent(step: Runnable): step is Agent {
  return step.kind === 'agent'
}
