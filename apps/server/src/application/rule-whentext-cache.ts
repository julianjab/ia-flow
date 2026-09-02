// Cache de veredictos del `whenText` de una regla — el mismo mecanismo que
// tenía el `agent-text-gate.ts` borrado, portado de "por agente" a "por
// regla".
//
// Sin esto, una regla con `whenText` que no aplica sobre un issue le
// pregunta a Haiku EN CADA EVENTO que la vuelve a matchear — un issue
// atascado en el estado que la activa (justo lo que pasa cuando el veredicto
// es "no aplica": nada corre, nada cambia) reevalúa para siempre en modo
// polling o con el fallback scan del webhook encendido.
//
// El veredicto sólo depende del criterio de la regla y de lo que el
// clasificador ve del issue, así que la key incluye las dos cosas: si
// alguien reescribe la descripción, el `whenText`, o aparece un comentario
// nuevo (`conversation` cambia), la entrada vieja deja de matchear sola y se
// vuelve a preguntar. No hay TTL a propósito — no hay nada que expire salvo
// un cambio de contenido, y ese ya está en la key.
//
// Lo que NO evita: la llamada a `loadComments` que arma `conversation` sigue
// pagándose en cada evaluación (el cache sólo puede chequearse DESPUÉS de
// tener la conversación, porque es parte de la key). Es el mismo costo que
// ya paga `TaskDispatcher.dispatch` por cada item que llega a intentar
// despachar — no una regresión de este módulo, y mitigarlo requeriría saber
// si hay comentarios nuevos SIN cargarlos, que ninguna fuente ofrece hoy.
import type { RuleClassificationInput } from './rule-classification.js'

const MAX_CACHED_VERDICTS = 500
const verdicts = new Map<string, boolean>()

// Separador de campos de la key: el caracter NUL (código 0) no puede
// aparecer en ningún título, descripción o texto de conversación real, así
// que dos keys distintas nunca colapsan por concatenación ambigua — con un
// separador imprimible, un título que lo contenga alcanzaría para
// confundirlas.
const KEY_FIELD_SEPARATOR = String.fromCharCode(0)

function verdictKey(ruleId: string, input: RuleClassificationInput): string {
  return [
    ruleId,
    input.agent.whenText,
    input.task.title,
    input.task.type,
    input.task.description,
    input.conversation ?? '',
  ].join(KEY_FIELD_SEPARATOR)
}

/** `undefined` = sin veredicto cacheado, hay que preguntarle al clasificador. */
export function cachedVerdict(ruleId: string, input: RuleClassificationInput): boolean | undefined {
  return verdicts.get(verdictKey(ruleId, input))
}

export function rememberVerdict(
  ruleId: string,
  input: RuleClassificationInput,
  verdict: boolean,
): void {
  const key = verdictKey(ruleId, input)
  // Evicción FIFO simple: el Map de JS itera en orden de inserción, así que
  // la primera key es la más vieja. No hace falta un LRU — el objetivo es
  // acotar memoria en un proceso de vida larga, no maximizar hit rate.
  if (verdicts.size >= MAX_CACHED_VERDICTS && !verdicts.has(key)) {
    const oldest = verdicts.keys().next().value
    if (oldest !== undefined) verdicts.delete(oldest)
  }
  verdicts.set(key, verdict)
}

/** Sólo para tests — el cache es global al proceso a propósito (ver arriba). */
export function clearRuleWhenTextVerdicts(): void {
  verdicts.clear()
}
