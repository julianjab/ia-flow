// El handler que conecta el bus con el matcher: un solo suscriptor que ve
// TODOS los eventos, elige qué reglas aplican y las corre.
//
// A diferencia del handler por manager que reemplaza (`issue-scanned-handler`,
// andamio de la fase 1), éste no está atado a un proyecto: el filtro por ámbito
// lo hace `matchScope` dentro de `matchRules`, contra el scope del evento.
import type { EngineEvent, Rule } from '@ia-flow/shared'
import type { EventHandler, EventOutcome } from './bus.js'
import { aggregateOutcomes } from './bus.js'
import { matchRules, summarizeRuleRejections } from './match.js'
import type { RunRuleDeps } from './runner.js'
import { runRule } from './runner.js'

export interface RuleEngineDeps extends RunRuleDeps {
  /** Reglas vigentes. Se lee por evento y no se congela: editar una regla en
   *  la UI tiene que aplicar sin reiniciar el daemon. */
  loadRules(event: EngineEvent): Promise<readonly Rule[]>
  /**
   * Gate semántico opcional (el `whenText` de una regla). Devuelve `null`
   * cuando el clasificador no pudo decidir; en ese caso la regla se **saltea**
   * en vez de adivinar, igual que hace `selectAgentGated` con los agentes.
   * Sin inyectar, `whenText` no filtra nada.
   */
  classifyRule?(input: { rule: Rule; event: EngineEvent }): Promise<boolean | null>
  onMatch?(info: { event: EngineEvent; matched: Rule[]; rejectedSummary: string }): void
}

export function createRuleEngineHandler(deps: RuleEngineDeps): EventHandler {
  return {
    id: 'rule-engine',
    // Acepta todo: cuáles reglas aplican lo decide `matchRules`, que necesita
    // el evento entero. Un `handles` más fino acá duplicaría ese criterio.
    handles: () => true,
    async handle(event: EngineEvent): Promise<EventOutcome> {
      const rules = await deps.loadRules(event)
      const { matched, rejected } = matchRules({ event, rules })
      deps.onMatch?.({ event, matched, rejectedSummary: summarizeRuleRejections(rejected) })
      if (!matched.length) return 'skipped'

      const outcomes: EventOutcome[] = []
      for (const rule of matched) {
        if (rule.whenText && deps.classifyRule) {
          const verdict = await deps.classifyRule({ rule, event })
          // `null` = el clasificador no pudo decidir. Saltear es preferible a
          // correr o a descartar: el evento se reintenta en el próximo ciclo
          // en vez de tomar una decisión inventada.
          if (verdict !== true) continue
        }
        outcomes.push(await runRule(rule, event, deps))
      }
      return aggregateOutcomes(outcomes)
    },
  }
}
