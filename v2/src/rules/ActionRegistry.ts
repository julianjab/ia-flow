import type { RuleActionEntry } from './actions/RuleActionEntry.js'

/** Acciones nombradas, reusables desde varias reglas vía RefAction — nunca
 *  apuntan a otra ref (mata ciclos sin necesitar detección en runtime). */
export class ActionRegistry {
  private readonly actions = new Map<string, RuleActionEntry>()

  register(id: string, action: RuleActionEntry): void {
    throw new Error('not implemented — rechazar si action.kind === "ref" (no ref-a-ref)')
  }

  resolve(id: string): RuleActionEntry | undefined {
    throw new Error('not implemented')
  }
}
