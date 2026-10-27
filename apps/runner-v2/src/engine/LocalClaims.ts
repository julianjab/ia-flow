/**
 * Las tasks que toma una sesión local de Claude Code poniéndoles un label (`inbox.labels.local`):
 * mientras lo tienen, no son del runner. El `when` del intake ya descarta sus eventos nuevos; esto
 * suelta lo que el runner tenía vivo cuando llegó el label —la ejecución que corre, una pausa que
 * vencería por su `timeout`, las corridas en cola— para que nada siga tocando la card.
 *
 * Los servicios se arman antes que el engine: el store se enchufa después (`connect`), como
 * `TaskDesk`. Sin store (o sin label), soltar no hace nada.
 */
import { type DomainEvent, type ExecutionStore, scopeExecutionKey } from '@ia-flow/agent-engine'

export class LocalClaims {
  private store: Pick<ExecutionStore, 'cancel'> | undefined

  constructor(
    /** El label de una task tomada en local; sin él, el concepto está apagado. */
    readonly label: string | undefined,
  ) {}

  connect(store: Pick<ExecutionStore, 'cancel'> | undefined): void {
    this.store = store
  }

  /** Si `labels` dice que la task está tomada en local. */
  claimed(labels: readonly string[]): boolean {
    return this.label !== undefined && labels.includes(this.label)
  }

  /** Corta lo vivo de la task de `scope` (el de sus eventos). Devuelve qué cortó, o `undefined`
   *  si no había con qué. */
  release(
    scope: Record<string, unknown>,
    reason: string,
  ): { execution?: string; waiting: boolean } | undefined {
    const key = scopeExecutionKey({ scope } as DomainEvent<unknown>)
    if (!this.store || key === undefined) return undefined
    return this.store.cancel(key, reason)
  }
}
