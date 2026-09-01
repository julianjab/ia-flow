// Registro en memoria de lo que un run de TERMINAL deja ver desde afuera.
//
// Un run de `anthropic-api` mide todo en su propio loop. Uno de tmux/iterm
// corre en un proceso de Claude Code que este daemon no instrumenta: lo único
// que llega son los hooks (`/api/hook-events`), que cuentan tool calls, y el
// path de la transcripción JSONL que el CLI escribe — que es la única fuente
// de `usage` y de modelo para esos runs. Todo se acumula acá por `runId` y se
// consume una vez, al cerrar el run (`buildFinishPatch`).

import type { RunUsage } from '@ia-flow/ai-providers'

export interface RunToolTelemetry {
  toolCalls: number
  /** Tool results the hook explicitly flagged as failures. Never inferred —
   *  the hook script decides, and a hook that predates the flag reports
   *  nothing, which counts as "no error observed". */
  toolErrors: number
  /** Los mismos dos contadores por nombre de tool. Los nombres son los que
   *  usa el CLI (`Bash`, `Read`, `mcp__ia-flow-tools__fs_write`…), no los
   *  del catálogo del engine: es lo que el hook ve. */
  toolBreakdown: Record<string, { calls: number; errors: number }>
  /** Usage sumado de la transcripción, cuando se pudo leer. */
  usage?: RunUsage
  /** Modelo que dominó la transcripción, cuando se pudo leer. */
  model?: string
}

/** Lo que un lector de transcripciones devuelve. Vive acá y no en el adapter
 *  porque es el contrato que `setTranscriptUsageReader` impone. */
export interface TranscriptUsage {
  usage: RunUsage
  model?: string
}

interface Entry extends RunToolTelemetry {
  touchedAt: number
  transcriptPath?: string
}

const TTL_MS = 6 * 60 * 60_000
const MAX_ENTRIES = 500
const entries = new Map<string, Entry>()

// El daemon inyecta cómo leer una transcripción (`composition/container.ts`,
// mismo patrón que `setSecretResolver`): este paquete no toca el disco, y un
// deploy sin filesystem de Claude Code simplemente no lo cablea.
let transcriptReader: ((path: string) => TranscriptUsage | undefined) | undefined

export function setTranscriptUsageReader(
  reader: ((path: string) => TranscriptUsage | undefined) | undefined,
): void {
  transcriptReader = reader
}

function sweep(now: number): void {
  for (const [runId, entry] of entries) {
    if (now - entry.touchedAt > TTL_MS) entries.delete(runId)
  }
  if (entries.size > MAX_ENTRIES) {
    const oldestFirst = [...entries.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)
    for (const [runId] of oldestFirst.slice(0, entries.size - MAX_ENTRIES)) {
      entries.delete(runId)
    }
  }
}

function touch(runId: string, now: number): Entry {
  const entry = entries.get(runId) ?? {
    toolCalls: 0,
    toolErrors: 0,
    toolBreakdown: {},
    touchedAt: now,
  }
  entry.touchedAt = now
  entries.set(runId, entry)
  return entry
}

/** Records one tool result reported by a Claude Code hook. `isError`
 *  undefined means the hook couldn't tell, and is counted as a call only. */
export function recordHookToolResult(
  runId: string,
  isError?: boolean,
  opts: { toolName?: string; transcriptPath?: string } = {},
): void {
  if (!runId) return
  const now = Date.now()
  const entry = touch(runId, now)
  entry.toolCalls++
  if (isError === true) entry.toolErrors++
  if (opts.toolName) {
    const tally = entry.toolBreakdown[opts.toolName] ?? { calls: 0, errors: 0 }
    tally.calls++
    if (isError === true) tally.errors++
    entry.toolBreakdown[opts.toolName] = tally
  }
  if (opts.transcriptPath) entry.transcriptPath = opts.transcriptPath
  sweep(now)
}

/** Guarda dónde está la transcripción del run sin contar nada. Lo llaman los
 *  hooks que no son un tool result (Stop, SessionStart). */
export function recordHookTranscript(runId: string, transcriptPath: string): void {
  if (!runId || !transcriptPath) return
  const now = Date.now()
  const entry = touch(runId, now)
  entry.transcriptPath = transcriptPath
  sweep(now)
}

// Lee la transcripción AL CONSUMIR y no al recibir el path: el archivo crece
// durante todo el run, y lo que interesa es la cuenta final. Un lector que
// falla degrada a "sin usage", nunca voltea el cierre del run.
function withUsage(entry: Entry): RunToolTelemetry {
  let usage = entry.usage
  let model = entry.model
  if (!usage && entry.transcriptPath && transcriptReader) {
    try {
      const read = transcriptReader(entry.transcriptPath)
      if (read) {
        usage = read.usage
        model = read.model
      }
    } catch {
      // Sin usage: el run cierra con tokens null, como antes de esto.
    }
  }
  return {
    toolCalls: entry.toolCalls,
    toolErrors: entry.toolErrors,
    toolBreakdown: { ...entry.toolBreakdown },
    ...(usage ? { usage } : {}),
    ...(model ? { model } : {}),
  }
}

/** Reads the tally without consuming it — for a run still in flight. */
export function peekRunTelemetry(runId: string): RunToolTelemetry | undefined {
  const entry = entries.get(runId)
  return entry ? withUsage(entry) : undefined
}

/** Reads and drops the tally. Called once when a run finishes. Returns
 *  undefined when nothing was ever recorded for the run. */
export function takeRunTelemetry(runId: string): RunToolTelemetry | undefined {
  const entry = entries.get(runId)
  entries.delete(runId)
  return entry ? withUsage(entry) : undefined
}

/** Test seam — drops every tally. */
export function resetRunTelemetry(): void {
  entries.clear()
}
