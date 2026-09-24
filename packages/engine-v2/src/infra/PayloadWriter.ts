import type { CommentTarget } from '../engine/Agent.js'

/**
 * El borde de escritura hacia la fuente remota que el `payload` representa
 * (GitHub, Slack, lo que sea) — `Agent.finalize()` ya muta `status`/
 * `agentWorking` en el propio objeto `payload` (efecto en memoria, visible
 * para el resto de la Pipeline en ESTE mismo dispatch), pero eso no
 * sobrevive el proceso ni le llega a quien esté mirando el issue afuera.
 * Este port es lo que hace esa mutación durable — opaco a propósito: quien
 * lo implementa (un adapter de GitHub Issues, uno de GitHub Projects, uno de
 * Slack) es quien sabe leer el `payload` para encontrar el id remoto; el
 * dominio nunca lo interpreta.
 */
export interface PayloadWriter {
  /** Aplica el nuevo status en la fuente remota. */
  applyStatus(payload: Record<string, unknown>, status: string): Promise<void>
  /** Publica el comentario de cierre en el target resuelto por `Agent.comment`/`AgentExit.comment`. */
  postComment(payload: Record<string, unknown>, target: CommentTarget, text: string): Promise<void>
}

let instance: PayloadWriter | undefined

export function setPayloadWriter(writer: PayloadWriter | undefined): void {
  instance = writer
}

/** Ausente por default — sin un PayloadWriter seteado, `Agent.finalize()`
 *  sigue mutando `payload` en memoria pero no persiste nada afuera (mismo
 *  criterio que un `Agent` sin `verify[]`: es capacidad opt-in, no un
 *  requisito del dominio). */
export function getPayloadWriter(): PayloadWriter | undefined {
  return instance
}
