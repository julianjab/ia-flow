import { type RunMessage, TASK_MESSAGE_EVENT, createEvent } from '@ia-flow/shared'
import type { IEventBus } from '../../domain/ports/IEventBus.js'
import type { IRunMessageRepository } from '../../domain/ports/IRunMessageRepository.js'
import type { IWaitRepository } from '../../domain/ports/IWaitRepository.js'

export interface EnqueueRunMessageInput {
  taskId: string
  body: string
  author?: string
  source?: string
}

/**
 * Inyecta un mensaje en el run de una tarea.
 *
 * Coordina tres ports —la cola, las esperas y el bus— y es esa coordinación,
 * no el encolado, lo que lo hace un caso de uso y no una lectura suelta.
 *
 * **Se acepta aunque no haya un run corriendo.** El mensaje queda pendiente y
 * lo drena el próximo turno; rechazarlo obligaría a quien escribe en el hilo a
 * saber si el agente está despierto, que es exactamente lo que no puede saber.
 *
 * **Un mensaje también es un evento**, y es lo que despierta a un run pausado:
 * `pause_for_message` arma una espera sobre `task.message`, y sin esta
 * publicación la pausa nunca terminaría — el mensaje quedaría encolado
 * esperando un turno que ya no va a llegar.
 */
export class EnqueueRunMessageUseCase {
  constructor(
    private readonly messages: IRunMessageRepository,
    private readonly waits: IWaitRepository,
    private readonly bus: IEventBus,
  ) {}

  async execute(input: EnqueueRunMessageInput): Promise<RunMessage> {
    const source = input.source ?? 'api'
    const message = await this.messages.enqueue({
      id: crypto.randomUUID(),
      taskId: input.taskId,
      runId: null,
      body: input.body,
      author: input.author,
      source,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
    })

    // El scope sale de la espera y no del pedido: es el único lugar donde
    // consta a qué proyecto pertenece la tarea sin volver a la fuente. Sin
    // espera viva no hay a quién despertar, y publicar un evento sin scope
    // lo dejaría visible sólo para las reglas globales — ruido, no señal.
    const wait = await this.waits.getByTask(input.taskId)
    if (wait) {
      await this.bus.publish(
        createEvent({
          type: TASK_MESSAGE_EVENT,
          source,
          scope: { projectId: wait.projectId, issueId: input.taskId },
          payload: { body: input.body, author: input.author, messageId: message.id },
        }),
      )
    }

    return message
  }
}
