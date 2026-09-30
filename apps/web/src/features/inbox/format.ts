import type { ExecutionSummary, ExecutionUsage, TraceEntry } from '@ia-flow/shared'

// Formato de lo que la bandeja muestra: horas, duraciones, tokens y la línea de
// una traza. Puro y sin Vue.

const pad = (n: number) => String(n).padStart(2, '0')

/** `HH:MM:SS` en hora local; el ISO crudo si no parsea. */
export function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** `3m 12s`, `18 s`, `1h 05m`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${pad(s % 60)}s`
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`
}

/** `38k`, `1.2M`, `950`. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Lo que gastó una ejecución, en una línea. */
export function usageLine(usage: ExecutionUsage): string {
  return `${tokens(usage.input_tokens)} in · ${tokens(usage.output_tokens)} out · ${tokens(usage.cache_read_tokens)} caché`
}

const STATUS_LABEL: Record<ExecutionSummary['status'], string> = {
  running: 'corriendo',
  paused: 'pausada',
  done: 'terminada',
  failed: 'falló',
  superseded: 'reemplazada',
}

export function executionStatus(status: ExecutionSummary['status']): string {
  return STATUS_LABEL[status]
}

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/** Una entrada de traza como las cuatro columnas de una `LogLine`. */
export function traceLine(entry: TraceEntry): {
  time: string
  level: LogLevel
  origin?: string
  message: string
} {
  const failed = entry.status === 'error'
  const level: LogLevel = entry.level ?? (failed ? 'error' : 'info')
  const took =
    entry.kind === 'span' && entry.phase === 'end' && entry.duration_ms !== undefined
      ? ` (${duration(entry.duration_ms)})`
      : ''
  const detail = failed && entry.status_message ? ` — ${entry.status_message}` : ''
  return {
    time: clock(entry.start_time),
    level: failed ? 'error' : level,
    origin: entry.scope,
    message: `${entry.name}${took}${detail}`,
  }
}
