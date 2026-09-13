// Short Spanish relative-time formatter ("hace 3 min", "hace 2 h", "hace
// 1 d"). Coarse-grained on purpose — sus consumidores muestran el ISO
// exacto en un tooltip. Vivía en features/executions/relativeTime.ts;
// subió acá al sumar un segundo consumidor (features/assistant) — cruzar
// features está prohibido, así que esto es lo compartido.

export function formatRelative(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diffSec = Math.max(0, Math.round((nowMs - t) / 1000))
  if (diffSec < 5) return 'ahora'
  if (diffSec < 60) return `hace ${diffSec} s`
  const min = Math.round(diffSec / 60)
  if (min < 60) return `hace ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.round(h / 24)
  return `hace ${d} d`
}
