import type { WaitRequest } from '@ia-flow/shared'
import type { ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'
import { createLogger } from '../logger.js'
import { resolveExpiry } from './wait.js'

// `pause_for_message` — el run se detiene CONSERVANDO dónde iba.
//
// La diferencia con `wait_for_event` NO es qué la despierta: es POR QUÉ para.
// Aquélla la decide el agente porque terminó lo que podía hacer, y no hay
// posición que conservar. Ésta pasa a mitad del trabajo, así que el loop
// devuelve la conversación entera como checkpoint y el próximo run la retoma.
//
// La unificación que hace que esto no sea un mecanismo aparte: **una pausa es
// una espera con un checkpoint colgado**. Misma tabla, mismo matcher.
//
// Por eso `on`/`when` son PARÁMETROS y no una constante. El default —el
// próximo mensaje de la tarea— es lo correcto cuando el agente se pausa a sí
// mismo: no sabe qué va a destrabar la situación, así que espera a quien le
// habló. Pero cuando la orden viene de afuera, quien la manda SÍ sabe ("pará
// hasta que se mergee el PR 5"), y hardcodear el evento tiraba esa
// información. Los tipos válidos son los del catálogo de eventos.
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
    /** Qué la despierta. Ausente ⇒ el próximo mensaje de la tarea. */
    on?: string[]
    /** Condiciones sobre ese evento, con la misma forma que las de una regla. */
    when?: WaitRequest['when']
  }): Promise<{ id: string }>
}

let port: PausePort | null = null

export function setPausePort(p: PausePort | null): void {
  port = p
}

registerTool({
  name: 'pause_for_message',
  description:
    'Pausá acá conservando dónde ibas: cuando te despierten, seguís desde este punto con lo que ya sabías. ' +
    'Por defecto te despierta el próximo mensaje de esta tarea — usalo cuando te pidan que pares o necesites ' +
    'una decisión que sólo una persona puede tomar. Si sabés QUÉ estás esperando (que se mergee un PR, que ' +
    'termine el CI), decilo en `on` y te despierta eso en vez del mensaje.',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Por qué parás. Queda en el log y lo ve quien mire la task.',
      },
      on: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Tipos de evento que te despiertan. Default: ['task.message'] (el próximo mensaje de la tarea).",
      },
      when: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            op: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['field', 'op'],
        },
        description: "Condiciones sobre el evento. P. ej. [{field:'pr.number',op:'=',value:'5'}].",
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
    const { reason, timeoutMs, on, when } = (input ?? {}) as {
      reason?: string
      timeoutMs?: number
      on?: string[]
      when?: WaitRequest['when']
    }
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
    // Un `on` vacío no es "sin restricción" como en otros filtros: sin al menos
    // un tipo, nada podría despertar la pausa. Se cae al default en vez de
    // rechazar — un agente que ya pidió parar tiene que poder cerrar su turno.
    const wakeOn = on?.length ? on : undefined
    const wait = await port.pause({
      projectId: projectId ?? '',
      taskId,
      agentId,
      expiresAt,
      reason,
      on: wakeOn,
      // Sin `on` propio, un `when` no tendría contra qué evaluarse: el default
      // es un mensaje de la tarea, cuyos campos el agente no está filtrando.
      when: wakeOn ? when : undefined,
    })

    // Pedir, no cortar: el loop lo aplica al tope de la vuelta siguiente.
    ctx.control.requestPause(reason)

    log.info({ waitId: wait.id, taskId, agentId, reason, on: wakeOn, expiresAt }, 'Run pausado')
    const despierta = wakeOn ? wakeOn.join(', ') : 'el próximo mensaje en esta tarea'
    return (
      `Pausado (${wait.id}). Seguís cuando llegue: ${despierta}. ` +
      `Vence el ${expiresAt}. No hace falta que hagas nada más.`
    )
  },
})
