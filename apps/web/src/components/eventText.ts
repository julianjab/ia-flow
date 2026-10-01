import type { PipelineDecision } from '@ia-flow/shared'

// Cómo se lee un evento del log y lo que decidió cada pipeline con él. Lo usan el
// detalle de una tarea (sus eventos) y la pantalla de entradas (lo que llegó a
// cada una): por eso vive acá y no en una feature. Puro y sin Vue.

const pad = (n: number) => String(n).padStart(2, '0')

/** `HH:MM:SS` en hora local; el ISO crudo si no parsea. */
export function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const GLYPH: Record<PipelineDecision['verdict'], string> = {
  ran: '✓',
  mismatch: '○',
  lost_to_exclusive: '⛔',
}

export const VERDICT: Record<PipelineDecision['verdict'], string> = {
  ran: 'corrió',
  mismatch: 'no aplicó',
  lost_to_exclusive: 'perdió el turno',
}

/** Los datos del evento en una línea, sin las claves que ya dice el contexto (p. ej. `issue`). */
export function eventSummary(
  summary: Record<string, string | number | boolean>,
  hide: readonly string[] = [],
): string {
  return Object.entries(summary)
    .filter(([k]) => !hide.includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ')
}

/** Qué pasó con el evento, en corto: las pipelines que corrieron por nombre; el resto, contadas. */
export function tally(decisions: PipelineDecision[]): { ran: string; rest: string } {
  const ran = decisions.filter((d) => d.verdict === 'ran').map((d) => d.pipeline_id)
  const lost = decisions.filter((d) => d.verdict === 'lost_to_exclusive').length
  const skipped = decisions.filter((d) => d.verdict === 'mismatch').length
  const rest = [
    lost ? `${lost} perdió el turno` : '',
    skipped ? `${skipped} ${skipped === 1 ? 'no aplicó' : 'no aplicaron'}` : '',
  ].filter(Boolean)
  return { ran: ran.length ? `✓ corrió ${ran.join(', ')}` : '', rest: rest.join(' · ') }
}

/** «no cumple: A (vino x); B (vino y)» → una condición por renglón. */
export function reasons(reason: string | undefined): string[] {
  if (!reason) return []
  const [head, body] = reason.includes(': ') ? reason.split(/: (.*)/s) : ['', reason]
  return (body ?? '').split('; ').map((part, i) => (i === 0 && head ? `${head}: ${part}` : part))
}
