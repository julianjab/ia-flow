import { describe, expect, it } from 'vitest'
import {
  buildSlackReviewMessage,
  renderMentions,
  resolveSlackReviewTarget,
  slackReviewBlockedReason,
} from '../slack-review.js'

const JULI = { id: 'U1', name: 'juli' }
const BOT = { id: 'B2', name: 'reviewer-bot', isBot: true }

describe('resolveSlackReviewTarget', () => {
  it('usa lo del repo cuando lo define', () => {
    expect(
      resolveSlackReviewTarget(
        { slackReviewChannel: 'C_REPO', slackReviewers: [JULI] },
        { slackReviewChannel: 'C_PROJ', slackReviewers: [BOT] },
      ),
    ).toEqual({ channel: 'C_REPO', reviewers: [JULI] })
  })

  // El caso que motiva el fallback por campo: un canal para todo el proyecto,
  // distinta gente por repo.
  it('cae campo por campo, no todo o nada', () => {
    expect(
      resolveSlackReviewTarget(
        { slackReviewers: [JULI] },
        { slackReviewChannel: 'C_PROJ', slackReviewers: [BOT] },
      ),
    ).toEqual({ channel: 'C_PROJ', reviewers: [JULI] })

    expect(
      resolveSlackReviewTarget(
        { slackReviewChannel: 'C_REPO' },
        { slackReviewChannel: 'C_PROJ', slackReviewers: [BOT] },
      ),
    ).toEqual({ channel: 'C_REPO', reviewers: [BOT] })
  })

  it('una lista vacía en el repo HEREDA, no significa "sin reviewers"', () => {
    expect(
      resolveSlackReviewTarget({ slackReviewers: [] }, { slackReviewers: [BOT] }).reviewers,
    ).toEqual([BOT])
  })

  it('un canal en blanco cuenta como ausente', () => {
    expect(
      resolveSlackReviewTarget({ slackReviewChannel: '   ' }, { slackReviewChannel: 'C_PROJ' })
        .channel,
    ).toBe('C_PROJ')
  })

  it('sin repo ni proyecto queda vacío', () => {
    expect(resolveSlackReviewTarget()).toEqual({ reviewers: [] })
  })
})

describe('slackReviewBlockedReason', () => {
  it('nombra el canal faltante antes que los reviewers', () => {
    expect(slackReviewBlockedReason({ reviewers: [JULI] })).toMatch(/canal/i)
  })

  it('nombra los reviewers cuando hay canal', () => {
    expect(slackReviewBlockedReason({ channel: 'C1', reviewers: [] })).toMatch(/reviewers/i)
  })

  it('undefined cuando el pedido se puede hacer', () => {
    expect(slackReviewBlockedReason({ channel: 'C1', reviewers: [JULI] })).toBeUndefined()
  })
})

describe('buildSlackReviewMessage', () => {
  it('menciona a personas y bots con la misma sintaxis', () => {
    expect(renderMentions([JULI, BOT])).toBe('<@U1> <@B2>')
  })

  it('el primer pedido explica qué revisar y linkea el PR', () => {
    const text = buildSlackReviewMessage({
      kind: 'first',
      reviewers: [JULI],
      prUrl: 'https://github.com/o/r/pull/7',
      prTitle: 'fix: algo',
    })
    expect(text).toContain('<@U1> porfavor revisar y aprobar este PR')
    expect(text).toContain('otros consumidores.')
    expect(text).toContain('fix: algo')
    expect(text).toContain('https://github.com/o/r/pull/7')
  })

  // El re-review NO repite el link: cae dentro del hilo, donde ya está.
  it('el re-review es corto y no repite el PR', () => {
    const text = buildSlackReviewMessage({
      kind: 're-review',
      reviewers: [JULI, BOT],
      prUrl: 'https://github.com/o/r/pull/7',
    })
    expect(text).toBe('<@U1> <@B2> se realizaron las correcciones porfavor revisar.')
  })
})
