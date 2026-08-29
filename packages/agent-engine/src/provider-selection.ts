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

/**
 * Expande candidatos comodín (`providerId` terminado en `*`, ej. `remote:*`)
 * contra los providers registrados EN ESTE MOMENTO.
 *
 * Es la pieza que convierte el dispatch en oferta/claim al estilo webhook:
 * el agente deja de nombrar una máquina ("corré en la mac de Julian") y pasa
 * a declarar una clase ("cualquier remoto registrado") — el server le ofrece
 * la tarea a todos los que matchean (la sonda de admisión con las pistas de
 * la tarea ES la oferta) y la toma el primero que acepta. Quién acepta qué
 * lo decide cada agent-host con sus admissionRules, no el roster.
 *
 * - El `when`/`whenText` del comodín se hereda en cada expandido.
 * - Un id ya nombrado explícito no se duplica (el explícito gana, conserva
 *   su posición y su config).
 * - Un comodín sin registrados expande a nada: el siguiente candidato del
 *   array es el fallback natural, sin diferir.
 * - Puro a propósito: recibe los ids como snapshot (el orquestador los saca
 *   de su registry) para poder testearse sin I/O.
 */
export function expandProviderWildcards(
  choices: AgentProviderChoice[],
  registeredIds: readonly string[],
): AgentProviderChoice[] {
  const explicit = new Set(
    choices.filter((c) => !c.providerId.endsWith('*')).map((c) => c.providerId),
  )
  const out: AgentProviderChoice[] = []
  for (const c of choices) {
    if (!c.providerId.endsWith('*')) {
      out.push(c)
      continue
    }
    const prefix = c.providerId.slice(0, -1)
    for (const id of registeredIds) {
      if (!id.startsWith(prefix)) continue
      if (explicit.has(id)) continue
      if (out.some((o) => o.providerId === id)) continue
      out.push({ ...c, providerId: id })
    }
  }
  return out
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
  /** Ids registrados AHORA, para expandir candidatos comodín (`remote:*`).
   *  Sin esto, un comodín expande a nada (y cae al siguiente candidato). */
  registeredIds?: () => readonly string[]
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
  // En paralelo: con un pool de agent-hosts, la oferta les llega a todos a la
  // vez (como una entrega de webhooks) y la espera es la sonda más lenta, no
  // la suma. El orden del array se preserva en el resultado, así que el
  // desempate entre varios que aceptan sigue siendo determinístico.
  const verdicts = await Promise.all(
    candidates.map((c) =>
      ask(c.providerId, {
        task,
        agentId,
        running: countRunningByProvider(c.providerId, capacity.snapshot),
        cap: capacity.limits?.[c.providerId]?.maxConcurrentRuns,
      }),
    ),
  )
  const admitted: AgentProviderChoice[] = []
  const declined: DeclinedProvider[] = []
  candidates.forEach((c, i) => {
    const verdict = verdicts[i] as Admission
    if (verdict.accept) admitted.push(c)
    else
      declined.push({
        providerId: c.providerId,
        reason: verdict.reason,
        retryAfterMs: verdict.retryAfterMs,
      })
  })
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
  const expanded = expandProviderWildcards(
    normalizeProviderChoices(provider),
    capacity.registeredIds?.() ?? [],
  )
  const eligible = filterProviderCandidates(expanded, task)
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
