/**
 * La respuesta de una persona en el hilo de un pedido de review, hasta la task a la que contesta:
 * `locateSlack` (puro, contra un hilo simulado), el texto que abre el hilo y el pipeline de entrada.
 */
import { describe, expect, it } from 'bun:test'
import { locateSlack, type SlackThreadPort } from '../../.config/actions/_lib/intake/slack.js'
import { withThreadRefs } from '../../.config/actions/_lib/slack/RequestSlackReviewAction.js'
import { globalPipelines } from './fixtures.js'
import { mountForTest } from './helpers.js'

const ROOT =
  '<@U1> porfavor revisar\nhttps://github.com/la-haus/subscriptions/pull/12\nIssue: la-haus/subscriptions#7'

function thread(root: { text: string; fromBot: boolean } | null = { text: ROOT, fromBot: true }) {
  const calls: string[] = []
  const port: SlackThreadPort = {
    rootOf: async (channel, threadTs) => {
      calls.push(`root ${channel} ${threadTs}`)
      return root ?? undefined
    },
    permalink: async (channel, ts) =>
      `https://x.slack.com/archives/${channel}/p${ts.replace('.', '')}`,
    userName: async (id) => `nombre-${id}`,
  }
  return { port, calls }
}

const reply = (extra: Record<string, unknown> = {}) => ({
  text: 'cambia el color del botón',
  channel: 'CREV1',
  author: 'UJULI',
  ts: '1700000001.000200',
  threadTs: '1700000000.000100',
  isThreadReply: true,
  ...extra,
})

describe('locateSlack', () => {
  it('turns a reply in the bot thread into a comment on the issue, from the thread itself', async () => {
    const { port } = thread()
    const location = await locateSlack(reply(), {
      threads: port,
      users: { julianjab: { id: 'UJULI' } },
    })
    expect(location).toMatchObject({
      owner: 'la-haus',
      repo: 'subscriptions',
      number: 7,
      pr: 12,
      emit: 'issue_comment',
      comment: { body: 'cambia el color del botón', author: 'julianjab', id: 1700000001000200 },
      extra: {
        action: 'created',
        source: 'slack',
        slack: {
          channel: 'CREV1',
          threadTs: '1700000000.000100',
          thread: 'https://x.slack.com/archives/CREV1/p1700000000000100',
        },
      },
    })
    expect(location).not.toHaveProperty('inspect')
    const { extra } = location as unknown as { extra: { replyInstructions: string } }
    expect(extra.replyInstructions).toContain('slack_post_message')
    expect(extra.replyInstructions).toContain('CREV1')
  })

  it('falls back to the Slack display name when the author is not in slack.users', async () => {
    const { port } = thread()
    expect(await locateSlack(reply(), { threads: port })).toMatchObject({
      comment: { author: 'nombre-UJULI' },
    })
  })

  it('asks the PR for the issue when the thread only carries the PR', async () => {
    const { port } = thread({
      text: 'revisar https://github.com/la-haus/subscriptions/pull/12',
      fromBot: true,
    })
    const location = await locateSlack(reply(), { threads: port })
    expect(location).toMatchObject({ pr: 12, inspect: 12 })
    expect(location).not.toHaveProperty('number')
  })

  it('skips what is not a reply to a review request of the bot', async () => {
    const { port, calls } = thread()
    for (const extra of [
      { isThreadReply: false },
      { threadTs: undefined },
      { text: '' },
      { author: undefined },
    ]) {
      expect(await locateSlack(reply(extra), { threads: port }), JSON.stringify(extra)).toEqual({
        skip: 'slack.message no es la respuesta de un hilo',
      })
    }
    expect(calls).toEqual([])

    const human = thread({ text: ROOT, fromBot: false })
    expect(await locateSlack(reply(), { threads: human.port })).toEqual({
      skip: 'el hilo no es un pedido del bot',
    })
    const missing = thread(null)
    expect(await locateSlack(reply(), { threads: missing.port })).toEqual({
      skip: 'el hilo no es un pedido del bot',
    })
    const noRefs = thread({ text: 'hola a todos', fromBot: true })
    expect(await locateSlack(reply(), { threads: noRefs.port })).toEqual({
      skip: 'el mensaje que abrió el hilo no trae un issue ni un PR',
    })
  })
})

describe('withThreadRefs', () => {
  it('adds the issue and the PR that the template left out', () => {
    expect(withThreadRefs('revisar', 'la-haus/subscriptions#7', 'https://gh/pr/12')).toBe(
      'revisar\nIssue: la-haus/subscriptions#7\nhttps://gh/pr/12',
    )
  })

  it('leaves the text alone when it already carries both', () => {
    const text = 'revisar https://gh/pr/12 de la-haus/subscriptions#7'
    expect(withThreadRefs(text, 'la-haus/subscriptions#7', 'https://gh/pr/12')).toBe(text)
  })

  it('adds only what is missing', () => {
    expect(withThreadRefs('x https://gh/pr/12', 'a/b#1', 'https://gh/pr/12')).toBe(
      'x https://gh/pr/12\nIssue: a/b#1',
    )
  })
})

describe('the Slack intake pipeline', () => {
  it('listens to slack.message replies and runs resolve_task', async () => {
    const mounted = await mountForTest()
    try {
      const intake = globalPipelines(mounted).find((pipeline) => pipeline.id === 'intake-slack')
      expect(intake?.on).toEqual(['slack.message'])
    } finally {
      mounted.stop()
    }
  })
})
