// Resuelve QUÉ provider corre un agente ya elegido por `selectAgent`.
//
// `AgentDefinition.provider` puede ser un string plano (forma original, sigue
// siendo válida y es la mayoría de los agentes hoy) o un array de candidatos
// (`AgentProviderChoice[]`), cada uno con su propio `when` estructurado
// (mismo DSL que `AgentActivationSchema.when`, evaluado sin I/O por
// `evalWhen`) y un `whenText` opcional en texto libre.
//
// Esto vive separado de `agent-selection.ts` a propósito: `selectAgent` es
// puro y testeable sin I/O (ver el comentario en la cabecera de ese archivo),
// y desambiguar entre providers candidatos puede necesitar una llamada a
// Haiku. Mezclar ambas cosas volvería asíncrono (y dependiente de red) al
// selector de agentes, que hoy no lo es.
import type { AgentDefinition, AgentProviderChoice, ProviderLimit, Task } from '@ia-flow/shared'
import { type PendingSnapshot, atCap, countRunningByProvider } from './capacity.js'
import { evalWhen } from './outcomes.js'

/**
 * Decide entre N candidatos ambiguos usando texto libre (`whenText`). Vive
 * fuera de este paquete (packages/ai-providers, que ya habla con la Anthropic
 * API) — inyectado como puerto para que este archivo no dependa de red.
 * `null` = no se pudo decidir (falla de red, timeout, respuesta fuera del set
 * de candidatos, etc.) — nunca lanza.
 */
export type ProviderClassifier = (input: {
  task: Task
  candidates: Array<{ providerId: string; whenText?: string }>
}) => Promise<string | null>

/** Un `provider` string plano se normaliza a un único choice sin `when` ni
 *  `whenText` — nunca ambiguo, nunca dispara Haiku. Garantiza que ningún
 *  agente existente (que hoy declara `provider` como string) cambia de
 *  comportamiento. */
export function normalizeProviderChoices(
  provider: AgentDefinition['provider'],
): AgentProviderChoice[] {
  if (typeof provider === 'string') return [{ providerId: provider }]
  return provider
}

/** Filtro estructurado, puro — mismo criterio que `matchesRepo`/`matchesStatus`
 *  en agent-selection.ts: un choice sin `when` siempre pasa. */
export function filterProviderCandidates(
  choices: AgentProviderChoice[],
  task: Task,
): AgentProviderChoice[] {
  return choices.filter(
    (c) => !c.when || evalWhen(task as unknown as Record<string, unknown>, c.when),
  )
}

/** Límites de concurrencia por provider (`ProviderConfig.providerLimits`) +
 *  cómo contar los runs en vuelo. Ambos opcionales: sin límites configurados
 *  esto es un no-op y `resolveProvider` se comporta exactamente como antes. */
export interface ProviderCapacity {
  limits?: Record<string, ProviderLimit>
  snapshot?: PendingSnapshot
  /**
   * Sonda opcional al provider mismo (`IAgentProvider.canAccept`) — la
   * ocupación que el daemon NO puede deducir del registry: un gateway remoto
   * compartido entre varios daemons, un rate limit propio del provider.
   * Nunca lanza (el port es fail-open, ver el contrato de `canAccept`).
   */
  canAccept?: (providerId: string) => Promise<boolean>
}

/**
 * Segundo filtro, ortogonal al de `when`: `when` dice si el provider **sirve**
 * para esta task (estático, sobre campos del issue); esto dice si **puede
 * ahora** (dinámico, sobre runs en vuelo).
 *
 * Se mantienen separados los dos resultados porque el caller los trata
 * distinto: sin candidatos estructurales el dispatch se skipea (es un
 * problema de configuración, reintentar no cambia nada); con todos los
 * candidatos saturados se difiere (reintentar es exactamente lo que hay que
 * hacer).
 */
export async function partitionByCapacity(
  candidates: AgentProviderChoice[],
  capacity: ProviderCapacity = {},
): Promise<{ admitted: AgentProviderChoice[]; saturated: AgentProviderChoice[] }> {
  const admitted: AgentProviderChoice[] = []
  const saturated: AgentProviderChoice[] = []
  for (const c of candidates) {
    const cap = capacity.limits?.[c.providerId]?.maxConcurrentRuns
    const running = countRunningByProvider(c.providerId, capacity.snapshot)
    // El cap local primero: es gratis y no sale del proceso. La sonda remota
    // sólo se paga para los candidatos que ya pasaron ese filtro.
    if (atCap(running, cap)) {
      saturated.push(c)
      continue
    }
    if (capacity.canAccept && !(await capacity.canAccept(c.providerId))) {
      saturated.push(c)
      continue
    }
    admitted.push(c)
  }
  return { admitted, saturated }
}

/** Resultado de `resolveProvider`. `saturated` existe para que el caller
 *  pueda diferir el issue (y reintentarlo cuando se libere un slot) en vez de
 *  tratarlo como un dispatch fallido más. */
export type ProviderResolution =
  | { kind: 'resolved'; providerId: string }
  | { kind: 'none' }
  | { kind: 'saturated'; providerIds: string[] }

/**
 * Resuelve el `providerId` final para un dispatch.
 *
 *   0 candidatos tras filtrar `when`  → `none` (el caller lo trata como "no
 *                                      hay provider que corra esto" —
 *                                      dispatch skipeado, sin fallback
 *                                      silencioso; reintentar no ayuda
 *                                      porque el filtro es estático)
 *   todos los que quedan, saturados   → `saturated` (el caller difiere el
 *                                      issue y lo reintenta al liberarse un
 *                                      slot — ver ProviderCapacity)
 *   1 candidato admitido              → ese, sin llamar a `classify`
 *   >1 y ninguno tiene `whenText`     → el primero por orden del array
 *                                       (mismo criterio de desempate
 *                                       determinístico que `position` usa
 *                                       entre agentes)
 *   >1 y ≥1 tiene `whenText`          → `classify()`; si devuelve `null` o un
 *                                       id fuera del set de candidatos →
 *                                       `none` (falla el dispatch, no se
 *                                       adivina)
 *
 * El cap por provider se aplica ANTES del classifier a propósito: así Haiku
 * nunca elige un provider que igual no podría tomar el trabajo, y se sigue
 * gastando como mucho una llamada por dispatch.
 */
export async function resolveProvider(
  provider: AgentDefinition['provider'],
  task: Task,
  classify: ProviderClassifier,
  capacity: ProviderCapacity = {},
): Promise<ProviderResolution> {
  const eligible = filterProviderCandidates(normalizeProviderChoices(provider), task)
  if (eligible.length === 0) return { kind: 'none' }

  const { admitted, saturated } = await partitionByCapacity(eligible, capacity)
  if (admitted.length === 0) {
    return { kind: 'saturated', providerIds: saturated.map((c) => c.providerId) }
  }
  if (admitted.length === 1) return { kind: 'resolved', providerId: admitted[0].providerId }

  const hasFreeText = admitted.some((c) => c.whenText)
  if (!hasFreeText) return { kind: 'resolved', providerId: admitted[0].providerId }

  const chosen = await classify({
    task,
    candidates: admitted.map((c) => ({ providerId: c.providerId, whenText: c.whenText })),
  })
  if (!chosen) return { kind: 'none' }
  return admitted.some((c) => c.providerId === chosen)
    ? { kind: 'resolved', providerId: chosen }
    : { kind: 'none' }
}
