import { describe, expect, it } from 'vitest'
import { parseMentions, parseSlackEvent, stripMention } from '../events.js'

const payload = (event: Record<string, unknown>, eventId = 'Ev1') => ({
  event_id: eventId,
  event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '100.1', text: 'hola', ...event },
})

describe('parseSlackEvent', () => {
  it('normalizes a mention of the bot', () => {
    expect(parseSlackEvent(payload({ text: '<@UBOT> crea un issue' }))).toEqual({
      kind: 'app_mention',
      eventId: 'Ev1',
      channel: 'C1',
      user: 'U1',
      text: '<@UBOT> crea un issue',
      ts: '100.1',
      isThreadReply: false,
      mentions: ['UBOT'],
      fromBot: false,
    })
  })

  it('tells a thread reply from the root message of a thread', () => {
    expect(parseSlackEvent(payload({ type: 'message', thread_ts: '99.0' }))).toMatchObject({
      kind: 'message',
      threadTs: '99.0',
      isThreadReply: true,
    })
    expect(parseSlackEvent(payload({ thread_ts: '100.1' }))).toMatchObject({
      threadTs: '100.1',
      isThreadReply: false,
    })
  })

  it('drops what is not a message worth reading', () => {
    expect(parseSlackEvent(payload({ bot_id: 'B1' }))).toBeUndefined()
    expect(parseSlackEvent(payload({ subtype: 'message_changed' }))).toBeUndefined()
    expect(parseSlackEvent(payload({ type: 'reaction_added' }))).toBeUndefined()
    expect(parseSlackEvent(payload({ user: undefined }))).toBeUndefined()
    expect(parseSlackEvent(payload({ text: undefined }))).toBeUndefined()
    expect(parseSlackEvent({ event_id: 'E' })).toBeUndefined()
    expect(parseSlackEvent(null)).toBeUndefined()
  })

  it('drops the messages of the bot itself', () => {
    expect(parseSlackEvent(payload({ user: 'UBOT' }), { botUserId: 'UBOT' })).toBeUndefined()
    expect(parseSlackEvent(payload({ user: 'U1' }), { botUserId: 'UBOT' })).toBeDefined()
  })

  describe('another bot', () => {
    const reply = { type: 'message', thread_ts: '99.0', bot_id: 'B1', user: 'UGORDO' }
    const self = { botUserId: 'UBOT' }

    it('drops every bot message when its own id is unknown (it could be its own: a loop)', () => {
      expect(parseSlackEvent(payload(reply))).toBeUndefined()
    })

    it('passes its reply inside a thread, marked as fromBot (a reviewer answering a review request)', () => {
      expect(parseSlackEvent(payload(reply), self)).toMatchObject({
        kind: 'message',
        user: 'UGORDO',
        isThreadReply: true,
        fromBot: true,
      })
    })

    it('uses the bot_id as author for a legacy bot_message without user', () => {
      expect(
        parseSlackEvent(payload({ ...reply, user: undefined, subtype: 'bot_message' }), self),
      ).toMatchObject({ user: 'B1', fromBot: true })
    })

    it('drops its messages outside a thread, its thread roots and its mentions', () => {
      expect(parseSlackEvent(payload({ ...reply, thread_ts: undefined }), self)).toBeUndefined()
      expect(parseSlackEvent(payload({ ...reply, thread_ts: '100.1' }), self)).toBeUndefined()
      expect(parseSlackEvent(payload({ ...reply, type: 'app_mention' }), self)).toBeUndefined()
    })

    it('drops its edits, and a bot_message subtype from a person', () => {
      expect(
        parseSlackEvent(payload({ ...reply, subtype: 'message_changed' }), self),
      ).toBeUndefined()
      expect(
        parseSlackEvent(
          payload({ type: 'message', thread_ts: '99.0', subtype: 'bot_message' }),
          self,
        ),
      ).toBeUndefined()
    })

    it('still drops the thread replies of the bot itself', () => {
      expect(
        parseSlackEvent(payload({ ...reply, user: 'UBOT' }), { botUserId: 'UBOT' }),
      ).toBeUndefined()
    })
  })
})

describe('parseMentions / stripMention', () => {
  it('lists each mentioned id once, with or without a name', () => {
    expect(parseMentions('<@U1> y <@U2|ana> y <@U1>')).toEqual(['U1', 'U2'])
    expect(parseMentions('sin menciones #general')).toEqual([])
  })

  it('removes the mention of the bot and tidies the text', () => {
    expect(stripMention('<@UBOT>   crea   un issue <@U2>', 'UBOT')).toBe('crea un issue <@U2>')
  })
})
