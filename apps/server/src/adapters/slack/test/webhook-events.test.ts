import { describe, expect, it } from 'bun:test'
import { SLACK_MESSAGE, slackMessageEvent } from '../webhook-events.js'

function envelope(over: Record<string, unknown> = {}) {
  return {
    type: 'event_callback',
    event_id: 'Ev123',
    event: {
      type: 'message',
      channel: 'C0BUGS',
      user: 'U123',
      text: 'el login anda mal en staging',
      ts: '1700000000.000100',
      ...over,
    },
  }
}

describe('slackMessageEvent', () => {
  it('produce el evento SIN scope', () => {
    // El punto del diseño: nadie sabe todavía de qué proyecto habla. Con
    // scope, lo verían las reglas de proyecto sin que nadie lo haya ruteado.
    const e = slackMessageEvent(envelope())
    expect(e?.type).toBe(SLACK_MESSAGE)
    expect(e?.scope).toEqual({})
    expect((e?.payload as { text: string }).text).toBe('el login anda mal en staging')
  })

  it('descarta los mensajes de bots', () => {
    // Sin esto, un agente que comenta en el hilo produce el evento que lo
    // despierta a él mismo — el loop más fácil de escribir sin darse cuenta.
    expect(slackMessageEvent(envelope({ bot_id: 'B1' }))).toBeNull()
  })

  it('descarta los subtipos: editar un mensaje no es un pedido nuevo', () => {
    expect(slackMessageEvent(envelope({ subtype: 'message_changed' }))).toBeNull()
    expect(slackMessageEvent(envelope({ subtype: 'channel_join' }))).toBeNull()
  })

  it('descarta un mensaje sin texto', () => {
    expect(slackMessageEvent(envelope({ text: '   ' }))).toBeNull()
  })

  it('marca si es respuesta en un hilo', () => {
    const raiz = slackMessageEvent(envelope({ thread_ts: '1700000000.000100' }))
    const respuesta = slackMessageEvent(envelope({ thread_ts: '1699999999.000000' }))
    expect((raiz?.payload as { isThreadReply: boolean }).isThreadReply).toBe(false)
    expect((respuesta?.payload as { isThreadReply: boolean }).isThreadReply).toBe(true)
  })

  it('el event_id de Slack es la identidad — Slack reintenta', () => {
    const a = slackMessageEvent(envelope())
    const b = slackMessageEvent(envelope())
    expect(a?.id).toBe(b?.id as string)
    expect(a?.id).toContain('Ev123')
  })
})
