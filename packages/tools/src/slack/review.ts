import type { ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'

// `request_slack_review` — pedir review del PR de la tarea en Slack.
//
// La tool NO sabe pedir el review: sabe quién lo sabe. Todo lo que decide
// (qué PR, si el CI terminó, qué canal, qué reviewers, primer review vs
// re-review) vive en el use-case del server, que es donde están los repos y el
// source. Acá sólo entra el port, cableado en `composition/container.ts` — este
// paquete no puede importar `apps/server`.
//
// Sin `task_id` usa el de la corrida (`ToolContext.taskId`): el agente no tiene
// por qué repetir un dato que el engine ya le dio, y escribirlo mal apuntaría el
// pedido a otra tarea.

export interface SlackReviewPort {
  requestReview(input: { taskId: string; projectId?: string }): Promise<string>
}

let port: SlackReviewPort | null = null

export function setSlackReviewPort(p: SlackReviewPort | null): void {
  port = p
}

registerTool({
  name: 'request_slack_review',
  description:
    'Pide review del Pull Request de esta tarea en Slack: taguea a los reviewers configurados para el repo en su canal. Si ya se había pedido review antes, el mensaje cae DENTRO del mismo hilo avisando que se hicieron las correcciones, en vez de abrir uno nuevo. Requiere un PR abierto con el CI terminado.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description:
          'Id de la tarea. Omitilo para usar la tarea de esta corrida, que es lo normal.',
      },
    },
    required: [],
  },
  async execute(input: any, ctx?: ToolContext): Promise<string> {
    if (!port) return 'El pedido de review en Slack no está disponible en este proceso.'
    const taskId = input?.task_id || ctx?.taskId
    if (!taskId) return 'No hay tarea a la que pedirle review (falta task_id).'
    return port.requestReview({ taskId })
  },
})
