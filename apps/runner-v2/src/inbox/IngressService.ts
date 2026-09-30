/**
 * Las entradas del runner —por dónde le llegan los eventos de afuera— y lo que les llegó: el webhook
 * de GitHub (GitHub hace POST) y Slack por Socket Mode (el runner abre la conexión). Lo que entra
 * queda en `event_log` como evento crudo con el prefijo de su entrada (`github.push`,
 * `slack.message`), con qué decidió cada pipeline; acá sólo se filtra por ese prefijo.
 *
 * Lo que no llega al engine no está: un webhook con la firma mal lo corta el servidor antes, y un
 * mensaje de Slack que ninguna pipeline escucha se descarta sin anotar.
 */
import type { EventLogEntry, Ingress, IngressSource } from '@ia-flow/shared'

/** Una entrada, como la declara la composición del runner. */
export interface IngressSpec {
  id: string
  name: string
  kind: IngressSource['kind']
  endpoint?: string
  configured: boolean
  missing?: string
}

/** Lo que la entrada necesita de la base de actividad. */
export interface IngressLog {
  ingressEvents(typePrefix: string, limit: number): EventLogEntry[]
  ingressCount(typePrefix: string, since?: string): { count: number; lastAt?: string }
}

export interface IngressServiceOptions {
  sources: IngressSpec[]
  log: IngressLog
  retentionDays: number
  now?: () => Date
}

const DAY_MS = 86_400_000
const EVENTS_LIMIT = 200

export class IngressService {
  constructor(private readonly options: IngressServiceOptions) {}

  private prefix(id: string): string {
    return `${id}.`
  }

  ingress(): Ingress {
    const { log, sources, retentionDays } = this.options
    const since = new Date((this.options.now?.() ?? new Date()).getTime() - DAY_MS).toISOString()
    return {
      retention_days: retentionDays,
      sources: sources.map((spec) => {
        const kept = log.ingressCount(this.prefix(spec.id))
        const recent = log.ingressCount(this.prefix(spec.id), since)
        return {
          ...spec,
          ...(kept.lastAt ? { last_at: kept.lastAt } : {}),
          count_24h: recent.count,
          count_kept: kept.count,
        }
      }),
    }
  }

  /** Lo que llegó a una entrada, del más nuevo; `undefined` si no es una entrada del runner. */
  events(id: string, limit = 50): EventLogEntry[] | undefined {
    if (!this.options.sources.some((spec) => spec.id === id)) return undefined
    return this.options.log.ingressEvents(
      this.prefix(id),
      Math.min(Math.max(limit, 1), EVENTS_LIMIT),
    )
  }
}
