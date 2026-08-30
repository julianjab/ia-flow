import type { EngineEvent, Rule } from '@ia-flow/shared'

/** Lo que el clasificador necesita para juzgar un `whenText`. */
export interface RuleClassificationInput {
  task: { title: string; description: string; type: 'functional' | 'technical' }
  agent: { id: string; whenText: string }
}

/**
 * `(regla, evento)` → la entrada del clasificador de `whenText`.
 *
 * Existe suelto y no dentro del cableado del daemon porque es una traducción
 * con reglas propias —qué campos del payload cuentan como el "issue" que el
 * modelo va a leer— y ésas se testean sin levantar nada.
 *
 * Los campos se toman del payload del evento, que es lo único que hay: un
 * `issue.scanned` los trae, pero un `ci.finished` o un `slack.message` no. Un
 * evento sin ellos se clasifica contra strings vacíos en vez de fallar — el
 * `whenText` es un gate, y hacerlo explotar dejaría al dispatch entero sin
 * correr por una regla que quizás ni matcheaba.
 */
export function toRuleClassificationInput(
  rule: Pick<Rule, 'id' | 'whenText'>,
  event: EngineEvent,
): RuleClassificationInput {
  const payload = event.payload as Record<string, unknown>
  const type = String(payload.type ?? '')
  return {
    task: {
      title: String(payload.title ?? ''),
      description: String(payload.description ?? ''),
      // El clasificador tipa esto como la unión cerrada, pero el payload es
      // texto libre: cualquier otra cosa se normaliza a `functional`, que es
      // el default del resto del sistema.
      type: type === 'technical' ? 'technical' : 'functional',
    },
    agent: { id: rule.id, whenText: rule.whenText ?? '' },
  }
}
