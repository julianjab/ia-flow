import { type Rule, RuleSchema } from '@ia-flow/shared'
import { planLegacyRename } from '../../../adapters/github/legacy-event-rename.js'
import type { IRuleRepository } from '../../../domain/ports/IRuleRepository.js'
import { createLogger } from '../../../logger.js'

const log = createLogger('yaml-rules')

/**
 * Reglas de un deploy headless: vienen del `runner.yaml` y son de SÓLO
 * LECTURA.
 *
 * Mismo criterio que `YamlAgentRepository`: el archivo es la fuente, y aceptar
 * escrituras que el próximo deploy pisaría sería peor que rechazarlas — un
 * operador que cree que guardó una regla y no la guardó es exactamente el fallo
 * silencioso que este modelo trata de eliminar.
 */
export class YamlRuleRepository implements IRuleRepository {
  private readonly rules: Rule[]

  constructor(rules: unknown[]) {
    // Se valida acá y no en el loader: el repositorio es el borde que garantiza
    // que lo que sale cumple el contrato, venga de donde venga.
    this.rules = RuleSchema.array()
      .parse(rules)
      .map((rule) => translateLegacyEventNames(rule))
      // Mismo orden que `ORDER BY position, id` de SQLite, para que el matcher
      // vea la misma prioridad en los dos backings.
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id))
  }

  isReadOnly(): boolean {
    return true
  }

  async visibleTo(projectId?: string): Promise<Rule[]> {
    // Fail-closed igual que el repo SQLite: sin projectId, sólo las globales.
    return this.rules.filter((r) =>
      projectId ? r.projectId == null || r.projectId === projectId : r.projectId == null,
    )
  }

  async list(scope?: { projectId?: string | null; global?: boolean }): Promise<Rule[]> {
    if (scope?.global) return this.rules.filter((r) => r.projectId == null)
    if (scope?.projectId) return this.rules.filter((r) => r.projectId === scope.projectId)
    return [...this.rules]
  }

  async getById(id: string): Promise<Rule | null> {
    return this.rules.find((r) => r.id === id) ?? null
  }

  async upsert(): Promise<Rule> {
    return this.readOnly()
  }

  async deleteById(): Promise<boolean> {
    return this.readOnly()
  }

  async setPositions(): Promise<void> {
    return this.readOnly()
  }

  private readOnly(): never {
    throw new Error('Las reglas de este deploy vienen del runner.yaml — son de sólo lectura')
  }
}

/**
 * Traduce el `on`/`when` de una regla del `runner.yaml` que todavía usa la
 * taxonomía curada de GitHub (`pr.opened`, `ci.finished`, …) — ver
 * `adapters/github/legacy-event-rename.ts`.
 *
 * A diferencia de la migración 080 (que reescribe SQLite una vez), un
 * `runner.yaml` no tiene dónde persistir el resultado: esto traduce EN
 * MEMORIA, en cada boot, y loguea qué hizo — es lo único que puede hacer un
 * repo read-only, pero es mejor que la regla quedándose callada sin que
 * nadie se entere. El archivo fuente sigue con los nombres viejos hasta que
 * alguien lo edite a mano.
 */
function translateLegacyEventNames(rule: Rule): Rule {
  const plan = planLegacyRename(rule.on, rule.when ?? null)
  if (plan === null) return rule
  if ('skip' in plan) {
    log.warn(
      { ruleId: rule.id, on: rule.on, reason: plan.reason },
      'regla del runner.yaml con nombres de evento viejos que no se puede traducir sola — revisar a mano',
    )
    return rule
  }
  log.warn(
    { ruleId: rule.id, before: rule.on, after: plan.onTypes },
    'regla del runner.yaml traducida en memoria a nombres crudos de evento — actualizá el YAML fuente para que esto deje de loguearse',
  )
  return { ...rule, on: plan.onTypes, when: plan.when }
}
