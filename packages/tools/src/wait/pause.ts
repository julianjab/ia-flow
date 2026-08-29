import type { ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'
import { createLogger } from '../logger.js'
import { resolveExpiry } from './wait.js'

// `pause_for_message` — un humano pidió por el hilo que el agente pare, y el
// run tiene que detenerse CONSERVANDO dónde iba.
//
// La diferencia con `wait_for_event`: aquélla la decide el agente porque
// terminó lo que podía hacer, y no hay posición que conservar. Ésta pasa a
// mitad del trabajo, así que el loop devuelve la conversación entera como
// checkpoint y el próximo run la retoma tal cual.
//
// La unificación que hace que esto no sea un mecanismo aparte: **una pausa es
// una espera con un checkpoint colgado**. Misma tabla, mismo matcher; lo único
// distinto es que el evento que la despierta es "el próximo mensaje de este
// hilo" y que trae estado.
//
// El corte no es inmediato: la tool lo PIDE y el loop lo aplica al tope de la
// vuelta siguiente, cuando el `tool_result` de esta llamada ya está en la
// historia. Cortar en el medio dejaría un `tool_use` sin respuesta y el
// request de reanudación fallaría.

const log = createLogger('tool-pause')

/** El evento que despierta a una pausa. Es un mensaje inyectado en la task —
 *  no lo elige el agente, porque una pausa por definición espera a la persona
 *  que la pidió. */
export { TASK_MESSAGE_EVENT } from '@ia-flow/shared'

export interface PausePort {
  /** Arma la espera con checkpoint. El checkpoint lo agrega el provider
   *  cuando el loop devuelve, no esta tool: acá todavía no existe. */
  pause(input: {
    projectId: string
    taskId: string
    agentId: string
    expiresAt: string
    reason?: string
  }): Promise<{ id: string }>
}

let port: PausePort | null = null

export function setPausePort(p: PausePort | null): void {
  port = p
}

registerTool({
  name: 'pause_for_message',
  description:
    'Pausá acá y esperá el próximo mensaje de quien te está hablando. ' +
    'Conservás dónde ibas: cuando llegue el mensaje, seguís desde este punto con lo que ya sabías. ' +
    'Usalo cuando te pidan que pares, o cuando necesites una decisión que sólo una persona puede tomar.',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Por qué parás. Queda en el log y lo ve quien mire la task.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Cuánto esperar como máximo. Default 1 hora, tope 7 días.',
      },
    },
  },
  // Sólo `sync`: en un provider de terminal el proceso del CLI sigue vivo, y
  // "pausar" ahí es dejar de alimentarlo — otra cosa, con otro mecanismo.
  providerKinds: ['sync'],
  async execute(input: unknown, ctx: ToolContext): Promise<string> {
    const { reason, timeoutMs } = (input ?? {}) as { reason?: string; timeoutMs?: number }
    if (!port) return 'Las pausas no están disponibles en este proceso.'
    if (!ctx.control) {
      // Sin canal de control la tool no puede cortar el turno, y armar la
      // espera igual dejaría al run corriendo con una pausa fantasma.
      return 'Error: esta tool sólo funciona dentro de un run — no hay loop que pausar.'
    }

    const { taskId, agentId, projectId } = ctx
    if (!taskId || !agentId) {
      return 'Error: no hay task o agente en contexto — no puedo armar la pausa.'
    }

    const expiresAt = resolveExpiry(timeoutMs, Date.now())
    const wait = await port.pause({
      projectId: projectId ?? '',
      taskId,
      agentId,
      expiresAt,
      reason,
    })

    // Pedir, no cortar: el loop lo aplica al tope de la vuelta siguiente.
    ctx.control.requestPause(reason)

    log.info({ waitId: wait.id, taskId, agentId, reason, expiresAt }, 'Run pausado')
    return (
      `Pausado (${wait.id}). Seguís cuando llegue el próximo mensaje en esta tarea. ` +
      `Vence el ${expiresAt}. No hace falta que hagas nada más.`
    )
  },
})
