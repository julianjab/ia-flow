import { Action } from '@ia-flow/agent-engine'
import type { SlackClient } from '@ia-flow/slack-api'
import { z } from 'zod'
import { transcript } from './transcript.js'

const Input = z.strictObject({
  channel: z.string().min(1).describe('El id del canal (ej. C0ABC123).'),
  limit: z.number().int().min(1).max(200).optional().describe('Cuántos mensajes (default 30).'),
})

/** `slack_channel_history`: los últimos mensajes de un canal, del más viejo al más nuevo. */
export class SlackChannelHistoryAction extends Action<typeof Input, string> {
  readonly description = 'Lee los últimos mensajes de un canal de Slack.'
  readonly input = Input
  override readonly sideEffects = 'none' as const

  constructor(private readonly client: SlackClient) {
    super({ id: 'slack_channel_history' })
  }

  async execute(input: z.infer<typeof Input>): Promise<string> {
    const messages = await this.client.history(input.channel, input.limit ?? 30)
    return transcript(this.client, [...messages].reverse())
  }
}
