import { EventFilter, type EventFilterProps } from '../condition/EventFilter.js'
import type { DomainEvent } from '../events/DomainEvent.js'

export interface PipelineTriggerProps extends EventFilterProps {
  /** Cada clave tiene que matchear EXACTO en `event.scope` (fail-closed). */
  scope?: Record<string, unknown>
  enabled?: boolean
}

/**
 * Qué eventos arrancan una pipeline: los de su `EventFilter` (`on` + `when` sobre el payload), con
 * su `scope` y si está habilitada. Explica por qué un evento NO la arranca — lo que queda en la
 * traza para cada regla que no corrió.
 */
export class PipelineTrigger extends EventFilter {
  readonly scope?: Record<string, unknown>
  readonly enabled: boolean

  constructor(props: PipelineTriggerProps) {
    super(props)
    this.scope = props.scope
    this.enabled = props.enabled ?? true
  }

  override matches(event: DomainEvent<any>): boolean {
    return this.explainMismatch(event) === undefined
  }

  /** Por qué `event` no la arranca, o `undefined` si la arranca. */
  explainMismatch(event: DomainEvent<any>): string | undefined {
    if (!this.enabled) return 'deshabilitada'
    if (!this.on.includes(event.type)) return `no escucha "${event.type}"`
    for (const [key, value] of Object.entries(this.scope ?? {})) {
      if (event.scope?.[key] !== value) {
        return `scope.${key}: esperaba ${JSON.stringify(value)}, vino ${JSON.stringify(event.scope?.[key]) ?? 'nada'}`
      }
    }
    return this.explainConditions(event.payload)
  }
}
