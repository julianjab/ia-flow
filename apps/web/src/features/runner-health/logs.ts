import type { RunnerLogLine } from '@ia-flow/shared'

// El log del server en la web: qué nivel pide cada segmento, cómo se suma lo nuevo y qué se copia.
// Puro: lo usa `RunnerLogs.vue`, y es lo mismo que hace el menú (`RunnerModel.pollLogs`).

export type LogFilter = 'all' | 'warn' | 'error'

export const LOG_FILTERS: readonly { id: LogFilter; label: string }[] = [
  { id: 'all', label: 'Todo' },
  { id: 'warn', label: 'Avisos' },
  { id: 'error', label: 'Errores' },
]

/** El `level` de `/api/logs` (el mínimo): «Todo» no filtra. */
export function levelOf(filter: LogFilter): 'warn' | 'error' | undefined {
  return filter === 'all' ? undefined : filter
}

/** Cuántas líneas se guardan en la vista: lo más viejo se cae. */
export const MAX_LINES = 500

/** Lo nuevo al final, sin repetir un `seq`, y sólo las últimas `MAX_LINES`. */
export function appendLines(
  current: RunnerLogLine[],
  incoming: RunnerLogLine[],
  max = MAX_LINES,
): RunnerLogLine[] {
  const last = current.at(-1)?.seq ?? -1
  return [...current, ...incoming.filter((l) => l.seq > last)].slice(-max)
}

/** `HH:MM:SS` en la hora local, o el texto tal cual si no es una fecha. */
export function clockOf(iso: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return iso
  return [t.getHours(), t.getMinutes(), t.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

/** El texto que se copia: una línea por renglón, como lo imprime el proceso. */
export function copyText(lines: RunnerLogLine[]): string {
  return lines
    .map((l) =>
      [l.time, l.level.toUpperCase(), `[${l.scope}]`, l.message, l.fields ?? '']
        .join(' ')
        .trimEnd(),
    )
    .join('\n')
}
