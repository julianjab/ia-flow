import type { Database } from 'bun:sqlite'
import type { EngineEvent } from '@ia-flow/shared'

/** Cuánto se recuerda un evento. Suficientemente largo para cubrir la ventana
 *  de reintentos de GitHub y Slack (minutos), y corto para que la tabla no
 *  crezca sin techo: es un registro operativo, no un log de auditoría. */
const RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * Dedupe por identidad del evento.
 *
 * `markProcessed` **inserta y responde si ya estaba**, en una sola operación.
 * Ese orden importa: consultar y después insertar deja una ventana en la que
 * dos entregas concurrentes del mismo id pasan las dos, que es exactamente el
 * caso que el dedupe existe para cubrir (GitHub reintenta en paralelo).
 */
export class SqliteProcessedEventRepository {
  constructor(private readonly db: Database) {}

  /** `true` = ya se había procesado, no lo vuelvas a entregar. */
  markProcessed(event: EngineEvent): boolean {
    const now = Date.now()
    // `INSERT OR IGNORE` + `changes`: si insertó, es nuevo; si no, ya estaba.
    // Es atómico, a diferencia de un SELECT seguido de un INSERT.
    const res = this.db.run(
      'INSERT OR IGNORE INTO processed_events (event_id, event_type, processed_at, expires_at) VALUES (?, ?, ?, ?)',
      [
        event.id,
        event.type,
        new Date(now).toISOString(),
        new Date(now + RETENTION_MS).toISOString(),
      ],
    )
    return res.changes === 0
  }

  /** Barre lo vencido. Lo llama el mismo tick que barre las esperas. */
  prune(now: string = new Date().toISOString()): number {
    return this.db.run('DELETE FROM processed_events WHERE expires_at <= ?', [now]).changes
  }
}
