import { describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  SLACK_MESSAGE,
  slackMessageEvent,
  urlVerification,
  verifySlackSignature,
} from '../webhook-events.js'

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

describe('urlVerification', () => {
  it('devuelve el challenge del handshake', () => {
    expect(urlVerification({ type: 'url_verification', challenge: 'abc' })).toBe('abc')
  })

  it('no confunde un mensaje con el handshake', () => {
    expect(urlVerification(envelope())).toBeNull()
  })
})

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

describe('verifySlackSignature', () => {
  const SECRET = 's3cr3t'
  const BODY = '{"type":"event_callback"}'
  const TS = '1700000000'
  const NOW = 1700000000

  function sign(ts: string, body: string) {
    return `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`
  }

  it('acepta una firma válida', () => {
    expect(verifySlackSignature(BODY, TS, sign(TS, BODY), SECRET, NOW)).toBe(true)
  })

  it('rechaza una firma de otro cuerpo', () => {
    expect(verifySlackSignature(BODY, TS, sign(TS, 'otro'), SECRET, NOW)).toBe(false)
  })

  it('rechaza un timestamp viejo — un delivery capturado no se reenvía para siempre', () => {
    const viejo = String(NOW - 600)
    expect(verifySlackSignature(BODY, viejo, sign(viejo, BODY), SECRET, NOW)).toBe(false)
  })

  it('rechaza cuando falta la firma o el timestamp', () => {
    expect(verifySlackSignature(BODY, undefined, sign(TS, BODY), SECRET, NOW)).toBe(false)
    expect(verifySlackSignature(BODY, TS, undefined, SECRET, NOW)).toBe(false)
  })

  it('un timestamp que no es número no pasa', () => {
    expect(verifySlackSignature(BODY, 'ayer', sign(TS, BODY), SECRET, NOW)).toBe(false)
  })
})
