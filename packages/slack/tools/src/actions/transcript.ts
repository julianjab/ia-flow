import type { SlackClient, SlackMessage } from '@ia-flow/slack-api'

/** Mensajes de Slack como texto para un modelo: `[ts] autor: texto`, con los nombres resueltos. */
export async function transcript(client: SlackClient, messages: SlackMessage[]): Promise<string> {
  const lines = await Promise.all(
    messages.map(async (message) => {
      const author = message.user
        ? await client.userName(message.user)
        : message.bot_id
          ? `bot:${message.bot_id}`
          : 'desconocido'
      return `[${message.ts}] ${author}: ${message.text ?? ''}`
    }),
  )
  return lines.join('\n') || '(sin mensajes)'
}
