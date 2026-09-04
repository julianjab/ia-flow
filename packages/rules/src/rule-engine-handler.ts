// El handler que conecta el bus con el matcher: un solo suscriptor que ve
// TODOS los eventos, elige qué reglas aplican y las corre.
//
// A diferencia del handler por manager que reemplaza (`issue-scanned-handler`,
// andamio de la fase 1), éste no está atado a un proyecto: el filtro por ámbito
// lo hace `matchScope` dentro de `matchRules`, contra el scope del evento.
import type { EngineEvent, Rule } from '@ia-flow/shared'
import type { EventHandler, EventOutcome } from './bus.js'
import { aggregateOutcomes } from './bus.js'
import { type RejectedRule, matchRules, summarizeRuleRejections } from './match.js'
import type { RunRuleDeps } from './runner.js'
import { runRule } from './runner.js'

export interface RuleEngineDeps extends RunRuleDeps {
  /** Reglas vigentes. Se lee por evento y no se congela: editar una regla en
   *  la UI tiene que aplicar sin reiniciar el daemon. */
  loadRules(event: EngineEvent): Promise<readonly Rule[]>
  /**
   * Condiciones base del scope del evento (global + proyecto), ANDeadas con
   * el `when` de CADA regla — ver `ProjectSettingsSchema.baseWhen`. Aplica
   * parejo a reglas globales y de proyecto: es una propiedad del EVENTO
   * ("este issue está blocked"), no de qué regla lo mira. Sin inyectar,
   * ninguna regla lleva restricción extra.
   */
  loadBaseWhen?(event: EngineEvent): Promise<readonly unknown[]>
  /**
   * Gate semántico opcional (el `whenText` de una regla). Devuelve `null`
   * cuando el clasificador no pudo decidir; en ese caso la regla se **saltea**
   * en vez de adivinar, igual que hace `selectAgentGated` con los agentes.
   * Sin inyectar, `whenText` no filtra nada.
   */
  classifyRule?(input: { rule: Rule; event: EngineEvent }): Promise<boolean | null>
  onMatch?(info: {
    event: EngineEvent
    matched: Rule[]
    /** El detalle completo de cada regla descartada, `whenTrace` incluido —
     *  `rejectedSummary` sigue siendo el resumen de una línea para el log
     *  humano; esto es lo que un consumidor usa para loguear POR QUÉ. */
    rejected: RejectedRule[]
    rejectedSummary: string
  }): void
}

/**
 * Un solo suscriptor que ve TODOS los eventos, elige qué reglas aplican y las
 * corre.
 *
 * A diferencia del handler por manager que reemplazó (andamio de la fase 1),
 * no está atado a un proyecto: el filtro por ámbito lo hace `matchScope`
 * dentro de `matchRules`, contra el scope del evento.
 */
export class RuleEngineHandler implements EventHandler {
  readonly id = 'rule-engine'

  constructor(private readonly deps: RuleEngineDeps) {}

  /** Acepta todo: cuáles reglas aplican lo decide `matchRules`, que necesita
   *  el evento entero. Un `handles` más fino acá duplicaría ese criterio. */
  handles(): boolean {
    return true
  }

  async handle(event: EngineEvent): Promise<EventOutcome> {
    const [rules, baseWhen] = await Promise.all([
      this.deps.loadRules(event),
      this.deps.loadBaseWhen?.(event) ?? Promise.resolve([]),
    ])
    const { matched, rejected } = matchRules({ event, rules, baseWhen })
    this.deps.onMatch?.({
      event,
      matched,
      rejected,
      rejectedSummary: summarizeRuleRejections(rejected),
    })
    if (!matched.length) return 'skipped'

    const outcomes: EventOutcome[] = []
    for (const rule of matched) {
      if (rule.whenText && this.deps.classifyRule) {
        const verdict = await this.deps.classifyRule({ rule, event })
        // `null` = el clasificador no pudo decidir. Saltear es preferible a
        // correr o a descartar: el evento se reintenta en el próximo ciclo en
        // vez de tomar una decisión inventada.
        if (verdict !== true) continue
      }
      outcomes.push(await runRule(rule, event, this.deps))
    }
    return aggregateOutcomes(outcomes)
  }
}
