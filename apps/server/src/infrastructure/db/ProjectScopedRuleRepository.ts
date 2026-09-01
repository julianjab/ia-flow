import { type Rule, isRuleDisabledInProject } from '@ia-flow/shared'
import type { IProjectRepository } from '../../domain/ports/IProjectRepository.js'
import type { IRuleRepository } from '../../domain/ports/IRuleRepository.js'

/**
 * Aplica las bajas por proyecto (`settings.disabledRuleIds`) sobre `visibleTo`.
 *
 * ── Por qué un decorador y no una condición en cada repo ─────────────────
 *
 * Hay DOS implementaciones de `IRuleRepository` (SQLite y el YAML del deploy
 * headless) y las dos tendrían que aprender lo mismo, cada una a su manera —una
 * en SQL, la otra filtrando un array— para un criterio que no depende del
 * storage. El decorador lo escribe una vez y las dos lo heredan.
 *
 * ── Por qué en `visibleTo` y no en el motor ──────────────────────────────
 *
 * Porque `visibleTo` **es** la pregunta "qué reglas existen para este
 * proyecto", y tiene dos consumidores que la hacen por motivos distintos: el
 * motor de reglas (qué dispara) y la vista de pipeline (qué hay, y qué status
 * quedan sin cubrir). Filtrar en el primero habría dejado al segundo contando
 * como cubierto un status que ya no lo está — el hueco más difícil de ver,
 * porque la pantalla dice que está todo bien.
 *
 * `list()` NO se toca, a propósito: es el CRUD, y ahí la regla tiene que
 * seguir apareciendo con su `enabled` REAL. Es lo que la pantalla del proyecto
 * necesita para dibujar el toggle — una regla que desaparece al apagarla es
 * una que no se puede volver a prender.
 *
 * Sin `projectId` no hay nada que filtrar: un evento sin scope sólo ve las
 * globales, y no hay proyecto que las haya dado de baja.
 */
export class ProjectScopedRuleRepository implements IRuleRepository {
  constructor(
    private readonly inner: IRuleRepository,
    private readonly projects: IProjectRepository,
  ) {}

  async visibleTo(projectId?: string): Promise<Rule[]> {
    const rules = await this.inner.visibleTo(projectId)
    if (!projectId) return rules
    const settings = this.projects.get(projectId)?.settings
    // Sin nada dado de baja, se devuelve el mismo array — el caso normal no
    // paga ni una pasada.
    if (!Array.isArray(settings?.disabledRuleIds) || settings.disabledRuleIds.length === 0) {
      return rules
    }
    return rules.filter((r) => !isRuleDisabledInProject(settings, r))
  }

  isReadOnly(): boolean {
    return this.inner.isReadOnly()
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
