import type { Rule } from '@ia-flow/shared'
import type { IRuleRepository } from '../domain/ports/IRuleRepository.js'

/**
 * Decora `IRuleRepository.visibleTo` para inyectar la regla fija que dispara
 * al asistente (`base-agents.yaml`) cuando se evalúan eventos del scope
 * `CHAT_PROJECT_ID` — sin que salga de la tabla `rules` ni sea editable
 * desde el CRUD. `CHAT_PROJECT_ID` no es un `Project` real, así que esta
 * regla nunca aparece en el editor de reglas de ningún proyecto del
 * operador. El resto de los métodos (list/upsert/delete/setPositions) pasan
 * directo: esta regla no se puede tocar desde ahí a propósito.
 */
export class SystemRuleRepository implements IRuleRepository {
  constructor(
    private inner: IRuleRepository,
    private chatProjectId: string,
    private baseRules: Rule[],
  ) {}

  isReadOnly(): boolean {
    return this.inner.isReadOnly()
  }

  async visibleTo(projectId?: string): Promise<Rule[]> {
    const rules = await this.inner.visibleTo(projectId)
    if (projectId !== this.chatProjectId || !this.baseRules.length) return rules
    return [...rules, ...this.baseRules]
  }

  list(scope?: { projectId?: string | null; global?: boolean }): Promise<Rule[]> {
    return this.inner.list(scope)
  }

  getById(id: string): Promise<Rule | null> {
    return this.inner.getById(id)
  }

  upsert(rule: Rule): Promise<Rule> {
    return this.inner.upsert(rule)
  }

  deleteById(id: string): Promise<boolean> {
    return this.inner.deleteById(id)
  }

  setPositions(ids: string[]): Promise<void> {
    return this.inner.setPositions(ids)
  }
}
