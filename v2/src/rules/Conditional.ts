import { Condition } from './Condition.js'

export interface ConditionalProps {
  when?: Condition[]
  whenText?: string
}

/**
 * Encapsula el patrón when/whenText que se repite en `Rule`, el `when`
 * por-paso de `RuleActionEntry` y `AgentProviderChoice`: condiciones puras
 * evaluadas sin I/O (`when`, vía `Condition.evaluateAll`) más un gate
 * semántico impuro evaluado APARTE (`whenText`, un clasificador tipo Haiku)
 * que descarta aunque sea el único candidato — nunca se funden en un mismo
 * chequeo porque uno es barato y sync y el otro no.
 *
 * Los métodos se llaman `matchesConditions`/`matchesConditionText` —no
 * `matches`/`matchesText`— a propósito: `Rule` (y cualquier otra subclase)
 * necesita SU PROPIO `matches(event, ...)` con una firma distinta (recibe un
 * DomainEvent, no un payload plano) para componer estos dos gates con sus
 * demás criterios; nombrarlos igual rompería el override (TS no acepta un
 * `matches` con parámetros incompatibles en una subclase).
 */
export abstract class Conditional {
  readonly when: Condition[]
  readonly whenText?: string

  constructor(props: ConditionalProps = {}) {
    this.when = props.when ?? []
    this.whenText = props.whenText
  }

  /**
   * Evalúa `this.when` contra el payload — puro, sin I/O. Ausente ⇒ true.
   * `extra` va ANTES de `this.when` (mismo orden que si fueran una sola
   * lista) — es lo que permite componer, ej. el `baseWhen` de un Project
   * ANDeado con el `when` propio de una Rule, sin que Conditional necesite
   * saber qué es un Project.
   */
  matchesConditions(payload: Record<string, unknown>, extra: Condition[] = []): boolean {
    return Condition.evaluateAll([...extra, ...this.when], payload)
  }

  /** Evalúa `this.whenText` — impuro (clasificador), cacheado por (this, payload). Ausente ⇒ true. */
  async matchesConditionText(payload: Record<string, unknown>): Promise<boolean> {
    if (this.whenText == null) return true
    throw new Error('not implemented — clasificador tipo Haiku contra this.whenText')
  }

  /** Atajo para el caso común: los dos gates, en el orden barato-primero. */
  async matchesAllConditions(payload: Record<string, unknown>): Promise<boolean> {
    return this.matchesConditions(payload) && (await this.matchesConditionText(payload))
  }
}
