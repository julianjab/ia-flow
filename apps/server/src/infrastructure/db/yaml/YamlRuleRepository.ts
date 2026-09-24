import { type Rule, RuleSchema } from '@ia-flow/shared'
import type { IRuleRepository } from '../../../domain/ports/IRuleRepository.js'

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

  /**
   * `translate` es un hook opcional, inyectado por `composition/container.ts`
   * — hoy lo usa para traducir en memoria una regla que todavía usa la
   * taxonomía vieja de eventos de GitHub (`adapters/github/
   * legacy-event-rename.ts`). Este archivo es `infrastructure/` y no puede
   * importar `adapters/**` (tabla de capas, CLAUDE.md raíz), así que recibe
   * la función ya resuelta en vez de conocer de dónde sale.
   */
  constructor(
    rules: unknown[],
    private readonly translate: (rule: Rule) => Rule = (rule) => rule,
  ) {
    // Se valida acá y no en el loader: el repositorio es el borde que garantiza
    // que lo que sale cumple el contrato, venga de donde venga.
    this.rules = RuleSchema.array()
      .parse(rules)
      .map((rule) => this.translate(rule))
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
