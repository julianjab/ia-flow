import { Action } from '@ia-flow/agent-engine'
import { parseSlackPermalink, type SlackClient } from '@ia-flow/slack-api'
import { z } from 'zod'
import { transcript } from './transcript.js'

const Input = z.strictObject({
  permalink: z.string().describe('El link de un mensaje de Slack (o de una respuesta en su hilo).'),
})

/** `slack_read_thread`: el hilo de un mensaje de Slack, desde su permalink. */
export class SlackReadThreadAction extends Action<typeof Input, string> {
  readonly description =
    'Lee un hilo de Slack completo (el mensaje raíz y sus respuestas) a partir del link de cualquiera de sus mensajes.'
  readonly input = Input
  override readonly sideEffects = 'none' as const

  constructor(private readonly client: SlackClient) {
    super({ id: 'slack_read_thread' })
  }

  async execute(input: z.infer<typeof Input>): Promise<string> {
    const ref = parseSlackPermalink(input.permalink)
    const messages = await this.client.replies({ channel: ref.channel, ts: ref.threadTs ?? ref.ts })
    return transcript(this.client, messages)
  }
}
