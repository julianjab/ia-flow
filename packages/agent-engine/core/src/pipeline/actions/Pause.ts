import { Condition, type ConditionRow } from '../../condition/Condition.js'
import { EventFilter } from '../../condition/EventFilter.js'
import type { DomainEvent } from '../../events/DomainEvent.js'

/** La rama con la que vence una pausa: se reanuda por ella, con un evento `execution.expired`. */
export const TIMEOUT_BRANCH = 'timeout'

/** Una `Pause` como datos: lo que guarda un store persistente para despertarla tras un reinicio. */
export interface PauseJSON {
  pauseId: string
  branches: Array<{ name: string; on: string[]; when: ConditionRow[] }>
  expiresAt?: number
}

/**
 * Una pausa en curso: qué la despierta (`match`) y cuándo vence. Es un valor —lo arma
 * `PauseAction` al correr y lo guarda la `Execution`— sin nada de la pipeline adentro.
 */
export class Pause {
  static fromJSON(json: PauseJSON): Pause {
    return new Pause(
      json.pauseId,
      json.branches.map(({ name, on, when }) => ({
        name,
        filter: new EventFilter({ on, when: Condition.fromRows(when) }),
      })),
      json.expiresAt,
    )
  }

  constructor(
    readonly pauseId: string,
    private readonly branches: ReadonlyArray<{ name: string; filter: EventFilter }>,
    /** `Date.now()` a partir del cual vence, si tiene `timeout`. */
    readonly expiresAt?: number,
    /** Lo que el paso que pausó necesita para seguir donde quedó (la conversación de un agente
     *  que espera): va al `Checkpoint.state`, no al JSON de la pausa. */
    readonly state?: unknown,
  ) {}

  /** La rama que `event` despierta — la primera que declara, si pasa más de una. */
  match(event: DomainEvent<any>): string | undefined {
    return this.branches.find(({ filter }) => filter.matches(event))?.name
  }

  expired(now: number): boolean {
    return this.expiresAt !== undefined && this.expiresAt <= now
  }

  /** Para la traza y los logs: `green: check_suite; red: check_suite`. */
  describe(): string {
    return this.branches.map(({ name, filter }) => `${name}: ${filter.on.join('|')}`).join('; ')
  }

  toJSON(): PauseJSON {
    return {
      pauseId: this.pauseId,
      branches: this.branches.map(({ name, filter }) => ({
        name,
        on: filter.on,
        when: filter.when.map((condition) => condition.toRow()),
      })),
      ...(this.expiresAt !== undefined ? { expiresAt: this.expiresAt } : {}),
    }
  }
}
