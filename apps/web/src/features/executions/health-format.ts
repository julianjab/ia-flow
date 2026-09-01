// Formato compartido por el panel de salud y la página del agente: los dos
// muestran los mismos números y tienen que leerse igual. Puro, sin Vue.

export const WINDOWS = [
  { label: '24 h', days: 1 },
  { label: '7 d', days: 7 },
  { label: '30 d', days: 30 },
] as const

export function percent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

export function duration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 60_000)} min`
}

export function compactTokens(n: number): string {
  if (n === 0) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// Null es "no se pudo estimar" (sin modelo, o modelo sin precio): se muestra
// como ausencia, nunca como $0 — un cero mandaría al agente al fondo de la
// lista de prioridades, que es justo donde no va.
export function formatUsd(usd: number | null): string {
  if (usd === null) return '—'
  if (usd < 0.01) return '<$0.01'
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd)}`
}

// Ordenadas para que las clases que apuntan a un problema de configuración
// arreglable lean primero — ésas son las que el loop de retro puede atacar.
export const CLASS_LABELS: Record<string, string> = {
  tool_failure: 'tools fallando',
  no_op: 'sin trabajo',
  budget_exhausted: 'budget agotado',
  iteration_cap: 'tope de iteraciones',
  server_tool_pause: 'pausa server-tool',
  refusal: 'rechazo',
  infra_error: 'infra',
  cancelled: 'cancelado',
  unknown: 'sin clasificar',
}
