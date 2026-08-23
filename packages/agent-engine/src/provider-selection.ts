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
import type { Admission, AdmissionRequest } from '@ia-flow/ai-providers'
import { withinDeclaredCap } from '@ia-flow/ai-providers'
import type { AgentDefinition, AgentProviderChoice, ProviderLimit, Task } from '@ia-flow/shared'
import { type PendingSnapshot, countRunningByProvider } from './capacity.js'
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

/** Qué necesita `resolveProvider` para armar el request de admisión y
 *  preguntarle a cada candidato. Todo opcional: sin nada de esto el filtro
 *  es un no-op y la resolución se comporta como antes de que existiera. */
export interface ProviderCapacity {
  /** Caps declarados en la UI (`ProviderConfig.providerLimits`). Se pasan al
   *  provider en el request; el engine no los enforcea por su cuenta. */
  limits?: Record<string, ProviderLimit>
  /** De dónde se cuentan los runs en vuelo. Default: el registry compartido. */
  snapshot?: PendingSnapshot
  /**
   * Le pregunta al provider. El default (`withinDeclaredCap`) es lo que hace
   * que el cap de la UI valga incluso para un provider que no implementa
   * `canAccept`. El caller real (AgentOrchestrator) resuelve el provider en
   * el registry y delega en su `canAccept` cuando lo tiene.
   */
  admit?: (providerId: string, req: AdmissionRequest) => Promise<Admission>
}

/** Un candidato que dijo que no, con el motivo que dio — va al log para que
 *  "diferido" no sea un misterio. */
export interface DeclinedProvider {
  providerId: string
  reason: string
  retryAfterMs?: number
}

/**
 * Segundo filtro, ortogonal al de `when`: `when` dice si el provider **sirve**
 * para esta task (estático, sobre campos del issue); esto dice si **quiere
 * tomarla ahora** (dinámico, y la respuesta es del provider, no del engine).
 *
 * Se mantienen separados los dos resultados porque el caller los trata
 * distinto: sin candidatos estructurales el dispatch se skipea (es un
 * problema de configuración, reintentar no cambia nada); con todos los
 * candidatos rechazando se difiere (reintentar es exactamente lo que hay que
 * hacer).
 */
export async function partitionByCapacity(
  candidates: AgentProviderChoice[],
  task: Task,
  capacity: ProviderCapacity = {},
  agentId?: string,
): Promise<{ admitted: AgentProviderChoice[]; declined: DeclinedProvider[] }> {
  const ask = capacity.admit ?? (async (_id, req) => withinDeclaredCap(req))
  const admitted: AgentProviderChoice[] = []
  const declined: DeclinedProvider[] = []
  for (const c of candidates) {
    const verdict = await ask(c.providerId, {
      task,
      agentId,
      running: countRunningByProvider(c.providerId, capacity.snapshot),
      cap: capacity.limits?.[c.providerId]?.maxConcurrentRuns,
    })
    if (verdict.accept) admitted.push(c)
    else
      declined.push({
        providerId: c.providerId,
        reason: verdict.reason,
        retryAfterMs: verdict.retryAfterMs,
      })
  }
  return { admitted, declined }
}

/** Resultado de `resolveProvider`. `saturated` existe para que el caller
 *  pueda diferir el issue (y reintentarlo cuando se libere un slot) en vez de
 *  tratarlo como un dispatch fallido más — y trae los motivos que dieron los
 *  candidatos, que es lo único que explica un "diferido" en el log. */
export type ProviderResolution =
  | { kind: 'resolved'; providerId: string }
  | { kind: 'none' }
  | { kind: 'saturated'; declined: DeclinedProvider[] }

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
 * La admisión se resuelve ANTES del classifier a propósito: así Haiku nunca
 * elige un provider que igual no iba a tomar el trabajo, y se sigue gastando
 * como mucho una llamada por dispatch.
 */
export async function resolveProvider(
  provider: AgentDefinition['provider'],
  task: Task,
  classify: ProviderClassifier,
  capacity: ProviderCapacity = {},
  agentId?: string,
): Promise<ProviderResolution> {
  const eligible = filterProviderCandidates(normalizeProviderChoices(provider), task)
  if (eligible.length === 0) return { kind: 'none' }

  const { admitted, declined } = await partitionByCapacity(eligible, task, capacity, agentId)
  if (admitted.length === 0) return { kind: 'saturated', declined }
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
