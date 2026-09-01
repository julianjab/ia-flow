// El productor cron — `schedule.tick`.
//
// Lo que habilita: barridos periódicos, recordatorios, health checks que
// produzcan eventos. Hoy no tienen lugar — el engine sólo reacciona a lo que
// pasa afuera, así que "revisá esto cada hora" no se puede expresar.
//
// El schedule vive EN LA REGLA y no en una tabla aparte. Una tabla obligaría a
// mantener sincronizadas dos cosas que siempre se editan juntas, y dejaría
// posible el estado sin sentido de un schedule que no apunta a ninguna regla.
//
// El parser es deliberadamente mínimo: cinco campos, `*`, listas y `*/n`. No
// hay rangos (`1-5`), ni nombres de mes, ni `@daily`. Un cron completo es una
// librería, y lo que este caso de uso necesita —"cada N minutos", "todos los
// días a las 9"— entra en veinte líneas que se pueden leer de una sentada.
import type { EngineEvent } from '@ia-flow/shared'
import { createEvent } from '@ia-flow/shared'

/** El tick de un schedule. Lo publica el productor cron; una regla lo espera
 *  con `on: ['schedule.tick']`. */
export const SCHEDULE_TICK = 'schedule.tick'

interface Field {
  /** `null` = `*`, matchea cualquier valor. */
  values: Set<number> | null
}

export interface CronSpec {
  minute: Field
  hour: Field
  dayOfMonth: Field
  month: Field
  dayOfWeek: Field
}

function parseField(raw: string, min: number, max: number): Field | null {
  if (raw === '*') return { values: null }

  const values = new Set<number>()
  for (const part of raw.split(',')) {
    const step = part.match(/^\*\/(\d+)$/)
    if (step) {
      const n = Number(step[1])
      if (!Number.isInteger(n) || n <= 0) return null
      for (let v = min; v <= max; v += n) values.add(v)
      continue
    }
    const n = Number(part)
    if (!Number.isInteger(n) || n < min || n > max) return null
    values.add(n)
  }
  return values.size ? { values } : null
}

/** `null` cuando la expresión no se entiende. Se valida al GUARDAR la regla,
 *  no al primer tick: una expresión rota que sólo falla en runtime es una
 *  regla que nunca dispara y nadie sabe por qué. */
export function parseCron(expr: string): CronSpec | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const minute = parseField(parts[0], 0, 59)
  const hour = parseField(parts[1], 0, 23)
  const dayOfMonth = parseField(parts[2], 1, 31)
  const month = parseField(parts[3], 1, 12)
  const dayOfWeek = parseField(parts[4], 0, 6)
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null

  return { minute, hour, dayOfMonth, month, dayOfWeek }
}

function matchesField(field: Field, value: number): boolean {
  return field.values === null || field.values.has(value)
}

/**
 * ¿Este minuto corresponde a esta expresión?
 *
 * Los días se evalúan con OR y no con AND cuando los dos están restringidos —
 * es la regla de cron de toda la vida, y la que hace que `0 9 1 * 1` signifique
 * "el día 1 **o** los lunes". Sorprende, pero cambiarla haría que una
 * expresión copiada de cualquier lado signifique otra cosa acá.
 */
export function matchesCron(spec: CronSpec, at: Date): boolean {
  if (!matchesField(spec.minute, at.getMinutes())) return false
  if (!matchesField(spec.hour, at.getHours())) return false
  if (!matchesField(spec.month, at.getMonth() + 1)) return false

  const domRestricted = spec.dayOfMonth.values !== null
  const dowRestricted = spec.dayOfWeek.values !== null
  const dom = matchesField(spec.dayOfMonth, at.getDate())
  const dow = matchesField(spec.dayOfWeek, at.getDay())

  if (domRestricted && dowRestricted) return dom || dow
  return dom && dow
}

/**
 * El evento de un tick.
 *
 * El `id` incluye la regla y el minuto exacto, así que **es idempotente por
 * construcción**: dos barridos que se solapan sobre el mismo minuto producen
 * el mismo id, y el dedupe del bus se come el segundo. Sin eso, un tick que
 * tarda más que el intervalo dispararía la regla dos veces.
 */
export function scheduleTickEvent(
  ruleId: string,
  at: Date,
  projectId?: string | null,
): EngineEvent {
  const minuteKey = at.toISOString().slice(0, 16)
  return createEvent({
    id: `schedule:${ruleId}:${minuteKey}`,
    type: SCHEDULE_TICK,
    source: 'cron',
    scope: projectId ? { projectId } : {},
    payload: { ruleId, at: at.toISOString() },
  })
}
