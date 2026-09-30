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

  it('drops what is not a human message worth reading', () => {
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
