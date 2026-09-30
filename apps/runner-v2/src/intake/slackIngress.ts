/**
 * Slack → engine, por Socket Mode: cada mensaje humano (mención o mensaje de un canal donde está el
 * bot) se despacha como `slack.message`, el equivalente del `github.<evento>` crudo de un webhook.
 * Acá no se interpreta nada: qué mensaje es un pedido, de qué task es un hilo y quién lo atiende es
 * trabajo de las pipelines de entrada (`on: [slack.message]`), igual que con GitHub.
 *
 *   @ia-flow/slack-socket (ack, dedupe, sin bots) → engine.dispatch(slack.message)
 *
 * Si ninguna pipeline escucha `slack.message` el mensaje se descarta en silencio: el bot recibe TODO
 * lo que se escribe en sus canales y anotarlo cada vez sólo haría ruido.
 */
import { createEvent, type DomainEvent } from '@ia-flow/agent-engine'
import type { SlackClient } from '@ia-flow/slack-api'
import {
  SlackSocketClient,
  type SlackSocketEvent,
  type SlackSocketOptions,
} from '@ia-flow/slack-socket'
import { createLogger, describeError, errorAttributes } from '@ia-flow/telemetry'
import type { MountedRunner } from '../boot.js'
import { listenedTypes, SLACK_PREFIX } from './listening.js'

const telemetryLog = createLogger('ia-flow-runner-v2.slack')

export const SLACK_MESSAGE = 'slack.message'

export interface SlackIngressOptions {
  /** El app token (`xapp-…`, `SLACK_APP_TOKEN`), o de dónde pedirlo. Sin él, no se levanta. */
  appToken: SlackSocketOptions['appToken']
  log: (line: string) => void
  /** Para inyectar `fetch`/`WebSocket`/`delay` en los tests. */
  socket?: Pick<SlackSocketOptions, 'fetchImpl' | 'webSocketImpl' | 'delay' | 'backoff'>
}

/** El scope de un mensaje: de dónde vino. Las pipelines globales lo completan con el del proyecto. */
export function slackScope(event: SlackSocketEvent): Record<string, string> {
  return {
    source: 'slack',
    channel: event.channel,
    ...(event.threadTs ? { thread: `${event.channel}:${event.threadTs}` } : {}),
  }
}

/** El `slack.message` de un mensaje (los campos de `event-catalog.ts` + lo que el intake necesita). */
export function slackMessageEvent(
  event: SlackSocketEvent,
  botUserId: string | undefined,
): DomainEvent<Record<string, unknown>> {
  return createEvent(
    SLACK_MESSAGE,
    {
      text: event.text,
      channel: event.channel,
      author: event.user,
      ts: event.ts,
      ...(event.threadTs ? { threadTs: event.threadTs } : {}),
      isThreadReply: event.isThreadReply,
      kind: event.kind,
      eventId: event.eventId,
      mentions: event.mentions,
      mentionsBot: botUserId !== undefined && event.mentions.includes(botUserId),
    },
    { scope: slackScope(event) },
  )
}

export interface SlackIngress {
  stop(): void
}

/**
 * Levanta el ingreso de Slack. `undefined` si no hay app token. Que Slack no conteste o rechace el
 * token NO tumba el runner (los webhooks de GitHub siguen): queda logueado y sin ingreso.
 */
export async function startSlackIngress(
  mounted: Pick<MountedRunner, 'pipelines' | 'engine'>,
  slack: Pick<SlackClient, 'enabled' | 'botUserId'>,
  options: SlackIngressOptions,
): Promise<SlackIngress | undefined> {
  const { log } = options
  // El id del bot hace falta para no despertarse con lo que uno mismo publica; sin bot token se
  // sigue igual (los mensajes de bots ya se descartan por `bot_id`).
  const botUserId = slack.enabled ? await slack.botUserId().catch(() => undefined) : undefined

  const dispatch = async (event: SlackSocketEvent) => {
    if (!listenedTypes(mounted, [SLACK_PREFIX]).has(SLACK_MESSAGE)) return
    try {
      await mounted.engine.dispatch(slackMessageEvent(event, botUserId))
    } catch (err) {
      log(
        `  ${SLACK_MESSAGE} (${event.channel} ${event.ts}): el despacho falló: ${describeError(err)}`,
      )
      telemetryLog.error(`${SLACK_MESSAGE}: el despacho falló`, {
        ...errorAttributes(err),
        'slack.channel': event.channel,
        'slack.ts': event.ts,
      })
    }
  }

  const socket = new SlackSocketClient({
    appToken: options.appToken,
    log,
    ...(botUserId ? { botUserId } : {}),
    ...options.socket,
    onEvent: dispatch,
  })
  if (!socket.enabled) return undefined
  try {
    await socket.start()
  } catch (err) {
    log(`→ aviso: Slack Socket Mode no arrancó: ${describeError(err)}`)
    return undefined
  }
  log('→ escuchando Slack por Socket Mode')
  return { stop: () => socket.stop() }
}
