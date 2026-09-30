/**
 * El host le manda al runner el uso de cada request de la sesión. `claude` escribe su transcripción
 * en el disco del host (`~/.claude/projects/<cwd>/<session>.jsonl`), donde el runner no llega: acá
 * se sigue con `TranscriptTail` y cada mensaje del modelo sale por `POST …/transcript`, donde el
 * runner lo registra como span `chat <model>` de la corrida (lo que leen los paneles de tokens).
 *
 * Best-effort, como la lectura local: un runner que no contesta o una transcripción que no aparece
 * nunca cortan la sesión.
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptMessage } from '@ia-flow/provider-shared'
import { TranscriptTail } from '@ia-flow/provider-shared'
import { createLogger } from '@ia-flow/telemetry'

const log = createLogger('provider-host')

/** Cada cuánto se mira lo nuevo de la transcripción: casi en vivo, sin un request por línea. */
const POLL_MS = 2_000

export interface TranscriptForwarder {
  /** Lee lo que falte, cierra el último mensaje y lo manda: la sesión terminó. */
  stop(): Promise<void>
}

export interface TranscriptForwarderOptions {
  /** La URL completa de `…/transcript` en el runner. */
  url: string
  sessionId: string
  /** Lo anterior a esto (una sesión retomada trae su historia) no se manda. */
  since?: Date
  /** Dónde vive la transcripción: default `~/.claude/projects`. */
  projectsDir?: string
  fetchImpl?: typeof fetch
  pollMs?: number
}

/** La transcripción de una sesión: el id es único, así que se busca por él en cada carpeta de
 *  proyecto sin adivinar cómo el CLI codifica el cwd. */
export async function findTranscript(
  sessionId: string,
  projectsDir = join(homedir(), '.claude', 'projects'),
): Promise<string | undefined> {
  let folders: string[]
  try {
    folders = await readdir(projectsDir)
  } catch {
    return undefined
  }
  for (const folder of folders) {
    const path = join(projectsDir, folder, `${sessionId}.jsonl`)
    if (
      await stat(path).then(
        (entry) => entry.isFile(),
        () => false,
      )
    )
      return path
  }
  return undefined
}

export function forwardTranscript(options: TranscriptForwarderOptions): TranscriptForwarder {
  const post = options.fetchImpl ?? fetch
  let outbox: TranscriptMessage[] = []
  const tail = new TranscriptTail({
    onMessage: (message) => outbox.push(message),
    ...(options.since ? { since: options.since } : {}),
  })

  const send = async (): Promise<void> => {
    if (outbox.length === 0) return
    const messages = outbox
    outbox = []
    try {
      const res = await post(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
      })
      if (!res.ok) log.warn(`el runner rechazó la transcripción (${res.status})`)
    } catch (error) {
      log.warn(`transcripción sin enviar: ${(error as Error).message}`)
    }
  }

  let path: string | undefined
  const step = async (flush: boolean): Promise<void> => {
    path ??= await findTranscript(options.sessionId, options.projectsDir)
    if (path) await tail.read(path, { flush })
    else if (flush) await tail.finish()
    await send()
  }

  let running: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    running = running.then(() => step(false)).catch(() => {})
  }, options.pollMs ?? POLL_MS)
  timer.unref?.()

  return {
    async stop() {
      clearInterval(timer)
      await running
      await step(true).catch(() => {})
    },
  }
}
