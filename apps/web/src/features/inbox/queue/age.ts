// La antigüedad de una card: corta, en mono, y «vieja» desde las 24 h. Puro: `now` se inyecta.

export const OLD_AFTER_HOURS = 24

export interface Age {
  /** `ahora`, `12 min`, `5 h`, `2 d`; vacío si la fecha no parsea. */
  text: string
  /** Desde las 24 h: se pinta en --warn. */
  old: boolean
  /** El ISO de origen, para el `title`/`datetime`. */
  iso: string
}

export function ageOf(iso: string, now: number): Age {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return { text: '', old: false, iso }
  const min = Math.max(0, Math.floor((now - t) / 60_000))
  const hours = Math.floor(min / 60)
  const text =
    min < 1
      ? 'ahora'
      : min < 60
        ? `${min} min`
        : hours < 24
          ? `${hours} h`
          : `${Math.floor(hours / 24)} d`
  return { text, old: hours >= OLD_AFTER_HOURS, iso }
}
