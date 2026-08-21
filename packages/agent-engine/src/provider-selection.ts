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
import type { AgentDefinition, AgentProviderChoice, Task } from '@ia-flow/shared'
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

/**
 * Resuelve el `providerId` final para un dispatch.
 *
 *   0 candidatos tras filtrar        → null (el caller trata esto como "no
 *                                      hay agente que corra este ciclo" —
 *                                      dispatch falla, se reintenta el
 *                                      próximo scan, sin fallback silencioso)
 *   1 candidato                       → ese, sin llamar a `classify`
 *   >1 y ninguno tiene `whenText`     → el primero por orden del array
 *                                       (mismo criterio de desempate
 *                                       determinístico que `position` usa
 *                                       entre agentes)
 *   >1 y ≥1 tiene `whenText`          → `classify()`; si devuelve `null` o un
 *                                       id fuera del set de candidatos →
 *                                       `null` (falla el dispatch, no se
 *                                       adivina)
 */
export async function resolveProvider(
  provider: AgentDefinition['provider'],
  task: Task,
  classify: ProviderClassifier,
): Promise<string | null> {
  const candidates = filterProviderCandidates(normalizeProviderChoices(provider), task)

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0].providerId

  const hasFreeText = candidates.some((c) => c.whenText)
  if (!hasFreeText) return candidates[0].providerId

  const chosen = await classify({
    task,
    candidates: candidates.map((c) => ({ providerId: c.providerId, whenText: c.whenText })),
  })
  if (!chosen) return null
  return candidates.some((c) => c.providerId === chosen) ? chosen : null
}
