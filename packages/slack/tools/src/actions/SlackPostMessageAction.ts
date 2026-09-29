import { Action } from '@ia-flow/agent-engine'
import { type SlackClient, threadTsOf } from '@ia-flow/slack-api'
import { z } from 'zod'

const Input = z.strictObject({
  channel: z.string().min(1).describe('El id del canal (ej. C0ABC123).'),
  text: z.string().min(1).describe('El mensaje (mrkdwn de Slack; `<@U123>` menciona).'),
  thread: z
    .string()
    .optional()
    .describe('El link de un mensaje del hilo donde responder. Sin esto, un mensaje nuevo.'),
})

/** `slack_post_message`: publica en un canal o en un hilo. Escribe: un agente sólo la recibe con
 *  `allowWrite()`; el canal se puede fijar desde la definición (`with: { channel }`). */
export class SlackPostMessageAction extends Action<typeof Input, string> {
  readonly description =
    'Publica un mensaje en un canal de Slack, o dentro de un hilo si pasás el link de uno de sus mensajes. Devuelve el link del mensaje.'
  readonly input = Input

  constructor(private readonly client: SlackClient) {
    super({ id: 'slack_post_message' })
  }

  async execute(input: z.infer<typeof Input>): Promise<string> {
    const posted = await this.client.postMessage({
      channel: input.channel,
      text: input.text,
      ...(input.thread ? { threadTs: threadTsOf(input.thread) } : {}),
    })
    return this.client.permalink(posted.channel, posted.ts)
  }
}
