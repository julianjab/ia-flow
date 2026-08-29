import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, type WaitRequest } from '@ia-flow/shared'
import type { ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'
import { createLogger } from '../logger.js'

// `wait_for_event` — el agente declara que no tiene más nada que hacer hasta
// que pase algo, y el run TERMINA.
//
// No suspende nada: un run vivo esperando se comería un slot de capacidad, el
// lock por task, el worktree y la sesión del provider — para mirar un CI de
// ocho minutos. Lo que persiste es la SUSCRIPCIÓN; el contexto no se pierde
// porque nunca vivió en el proceso: vive en el issue, sus comentarios y la
// memoria del agente.
//
// Es una tool y no un `exit` declarativo porque la decisión de esperar aparece
// EN MEDIO del razonamiento: el agente terminó de pushear y recién ahí sabe
// que lo próximo que le importa es el CI.
//
// El scope lo pone el runtime, igual que en `memory_*`: la task y el proyecto
// salen de `ctx`, nunca de un argumento. Un agente que pudiera nombrar la task
// de otro armaría una espera que despierta el run equivocado.

const log = createLogger('tool-wait')

/** Vista angosta del store de esperas, cableada por el composition root. */
export interface WaitPort {
  create(input: {
    projectId: string
    taskId: string
    agentId: string
    on: string[]
    when?: WaitRequest['when']
    expiresAt: string
    createdByRun?: string
    reason?: string
  }): Promise<{ id: string }>
}

let port: WaitPort | null = null

export function setWaitPort(p: WaitPort | null): void {
  port = p
}

/** Recorta el timeout pedido al tope duro. Se recorta y no se rechaza: una
 *  espera de un mes es indistinguible de una task abandonada, pero fallar la
 *  tool dejaría al agente sin forma de cerrar su turno. */
export function resolveExpiry(timeoutMs: number | undefined, now: number): string {
  const requested = timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  return new Date(now + Math.min(requested, MAX_WAIT_TIMEOUT_MS)).toISOString()
}

registerTool({
  name: 'wait_for_event',
  description:
    'Termina tu turno y quedate esperando un evento (por ejemplo que termine el CI). ' +
    'El run se cierra y se reanuda cuando el evento llegue: no ocupás capacidad mientras esperás. ' +
    'Usalo cuando no tenés nada más que hacer hasta que pase algo afuera.',
  input_schema: {
    type: 'object',
    properties: {
      on: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Tipos de evento que te despiertan. P. ej. ['ci.finished'], ['pr.review_submitted'].",
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
        description:
          "Condiciones sobre el evento, opcionales. P. ej. [{field:'conclusion',op:'=',value:'success'}].",
      },
      timeoutMs: {
        type: 'number',
        description: 'Cuánto esperar como máximo. Default 1 hora, tope 7 días.',
      },
      reason: {
        type: 'string',
        description: 'Qué estás esperando, para el log y para quien mire la task.',
      },
    },
    required: ['on'],
  },
  // Sólo `sync`: en un provider de terminal el proceso del CLI sigue vivo y
  // "esperar" ahí significa otra cosa (dejar de alimentarlo), que no es lo que
  // esta tool hace.
  providerKinds: ['sync'],
  async execute(input: unknown, ctx: ToolContext): Promise<string> {
    const { on, when, timeoutMs, reason } = (input ?? {}) as WaitRequest
    if (!port) return 'Las esperas no están disponibles en este proceso.'
    if (!Array.isArray(on) || on.length === 0) {
      return 'Error: `on` tiene que listar al menos un tipo de evento — si no, nada podría despertarte.'
    }

    const { taskId, agentId, projectId } = ctx
    if (!taskId || !agentId) {
      // Sin task ni agente la espera no se puede scopear, y una espera sin
      // scope despertaría con el evento de cualquier otra task.
      return 'Error: no hay task o agente en contexto — no puedo armar la espera.'
    }

    const expiresAt = resolveExpiry(timeoutMs, Date.now())
    const wait = await port.create({
      projectId: projectId ?? '',
      taskId,
      agentId,
      on,
      when,
      expiresAt,
      reason,
    })

    log.info({ waitId: wait.id, taskId, agentId, on, expiresAt, reason }, 'Espera armada')
    return (
      `Espera armada (${wait.id}). Te vas a despertar con: ${on.join(', ')}. ` +
      `Vence el ${expiresAt}. Tu turno termina acá.`
    )
  },
})
