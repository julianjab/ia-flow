import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SLACK_REVIEW_MESSAGES,
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
    ).toMatchObject({ channel: 'C_REPO', reviewers: [JULI] })
  })

  // El caso que motiva el fallback por campo: un canal para todo el proyecto,
  // distinta gente por repo.
  it('cae campo por campo, no todo o nada', () => {
    expect(
      resolveSlackReviewTarget(
        { slackReviewers: [JULI] },
        { slackReviewChannel: 'C_PROJ', slackReviewers: [BOT] },
      ),
    ).toMatchObject({ channel: 'C_PROJ', reviewers: [JULI] })

    expect(
      resolveSlackReviewTarget(
        { slackReviewChannel: 'C_REPO' },
        { slackReviewChannel: 'C_PROJ', slackReviewers: [BOT] },
      ),
    ).toMatchObject({ channel: 'C_REPO', reviewers: [BOT] })
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
    expect(resolveSlackReviewTarget()).toEqual({
      reviewers: [],
      messages: DEFAULT_SLACK_REVIEW_MESSAGES,
    })
  })
})

describe('slackReviewBlockedReason', () => {
  it('nombra el canal faltante antes que los reviewers', () => {
    expect(slackReviewBlockedReason({ reviewers: [JULI], messages: DEFAULT_SLACK_REVIEW_MESSAGES })).toMatch(/canal/i)
  })

  it('nombra los reviewers cuando hay canal', () => {
    expect(slackReviewBlockedReason({ channel: 'C1', reviewers: [], messages: DEFAULT_SLACK_REVIEW_MESSAGES })).toMatch(/reviewers/i)
  })

  it('undefined cuando el pedido se puede hacer', () => {
    expect(slackReviewBlockedReason({ channel: 'C1', reviewers: [JULI], messages: DEFAULT_SLACK_REVIEW_MESSAGES })).toBeUndefined()
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

// ─── Plantillas configurables ──────────────────────────────────────────────
// El contrato acá es el opuesto al habitual: lo que NO se puede romper es el
// texto de quien no configuró nada. Por eso el primer test compara byte a byte
// contra el literal histórico (typos incluidos) en vez de contra la constante,
// que podría cambiar sin que el test se entere.

const FIRST_LEGACY =
  '<@U1> porfavor revisar y aprobar este PR, revisar a detalle que la implementacion ' +
  'no vaya a afectar ningun servicio con un bug o modificando contratos que puedan afectar ' +
  'otros consumidores.\nfix: algo\nhttps://github.com/o/r/pull/7'

describe('plantillas configurables', () => {
  const pr = { prUrl: 'https://github.com/o/r/pull/7', prTitle: 'fix: algo' }

  it('sin configurar nada, el texto es EXACTAMENTE el de siempre', () => {
    const target = resolveSlackReviewTarget()
    expect(
      buildSlackReviewMessage({
        kind: 'first',
        reviewers: [JULI],
        ...pr,
        messages: target.messages,
      }),
    ).toBe(FIRST_LEGACY)
    expect(
      buildSlackReviewMessage({
        kind: 're-review',
        reviewers: [JULI],
        ...pr,
        messages: target.messages,
      }),
    ).toBe('<@U1> se realizaron las correcciones porfavor revisar.')
  })

  it('el repo overridea `first` y HEREDA `reReview`', () => {
    const target = resolveSlackReviewTarget(
      { slackReviewMessage: { first: 'ojo {{mentions}}: {{prUrl}}' } },
      { slackReviewMessage: { reReview: 'de nuevo {{mentions}}' } },
    )
    expect(buildSlackReviewMessage({ kind: 'first', reviewers: [JULI], ...pr, messages: target.messages })).toBe(
      'ojo <@U1>: https://github.com/o/r/pull/7',
    )
    expect(
      buildSlackReviewMessage({ kind: 're-review', reviewers: [JULI], ...pr, messages: target.messages }),
    ).toBe('de nuevo <@U1>')
  })

  it('el proyecto manda cuando el repo no define, y el repo gana cuando define', () => {
    const project = { slackReviewMessage: { first: 'del proyecto {{prTitle}}' } }
    expect(resolveSlackReviewTarget(undefined, project).messages.first).toBe('del proyecto {{prTitle}}')
    expect(
      resolveSlackReviewTarget({ slackReviewMessage: { first: 'del repo' } }, project).messages.first,
    ).toBe('del repo')
  })

  it('un texto en blanco HEREDA, igual que el canal', () => {
    const target = resolveSlackReviewTarget(
      { slackReviewMessage: { first: '   ', reReview: '' } },
      { slackReviewMessage: { first: 'del proyecto' } },
    )
    expect(target.messages.first).toBe('del proyecto')
    expect(target.messages.reReview).toBe(DEFAULT_SLACK_REVIEW_MESSAGES.reReview)
  })

  // Sin título, la línea del `{{prTitle}}` se va entera: un renglón vacío en
  // medio del mensaje se lee como un error de formato.
  it('sin `prTitle` la línea del título no queda en blanco', () => {
    const text = buildSlackReviewMessage({
      kind: 'first',
      reviewers: [JULI],
      prUrl: 'https://github.com/o/r/pull/7',
      messages: DEFAULT_SLACK_REVIEW_MESSAGES,
    })
    expect(text).not.toMatch(/\n\s*\n/)
    expect(text.endsWith('otros consumidores.\nhttps://github.com/o/r/pull/7')).toBe(true)
  })

  it('una variable desconocida se deja tal cual, no se borra la línea', () => {
    expect(
      buildSlackReviewMessage({
        kind: 'first',
        reviewers: [JULI],
        ...pr,
        messages: { first: 'hola {{nope}}' },
      }),
    ).toBe('hola {{nope}}')
  })
})
