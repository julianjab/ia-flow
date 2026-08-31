import { afterEach, describe, expect, it } from 'bun:test'
import {
  isSlackEnabled,
  isSlackWebhookEnabled,
  slackDisabledReason,
  slackStatus,
} from './enabled.js'

// El token es el interruptor, y se lee POR USO: estos tests lo mueven en
// caliente justamente porque en producción llega después del boot
// (`envRepo.loadIntoProcess()`).
const ORIGINAL = {
  token: Bun.env.SLACK_BOT_TOKEN,
  secret: Bun.env.SLACK_SIGNING_SECRET,
}

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete Bun.env[key]
  else Bun.env[key] = value
}

afterEach(() => {
  setEnv('SLACK_BOT_TOKEN', ORIGINAL.token)
  setEnv('SLACK_SIGNING_SECRET', ORIGINAL.secret)
})

describe('el interruptor de Slack', () => {
  it('sin token está apagado, y dice por qué', () => {
    setEnv('SLACK_BOT_TOKEN', undefined)
    expect(isSlackEnabled()).toBe(false)
    expect(slackDisabledReason()).toContain('SLACK_BOT_TOKEN')
  })

  it('con token está prendido y no hay motivo que reportar', () => {
    setEnv('SLACK_BOT_TOKEN', 'xoxb-1')
    expect(isSlackEnabled()).toBe(true)
    expect(slackDisabledReason()).toBeUndefined()
  })

  it('un token en blanco cuenta como ausente', () => {
    setEnv('SLACK_BOT_TOKEN', '   ')
    expect(isSlackEnabled()).toBe(false)
  })

  it('se lee en cada llamada — el token puede llegar después del boot', () => {
    setEnv('SLACK_BOT_TOKEN', undefined)
    expect(isSlackEnabled()).toBe(false)
    setEnv('SLACK_BOT_TOKEN', 'xoxb-1')
    expect(isSlackEnabled()).toBe(true)
  })

  it('hablar y escuchar son interruptores independientes', () => {
    setEnv('SLACK_BOT_TOKEN', 'xoxb-1')
    setEnv('SLACK_SIGNING_SECRET', undefined)
    expect(isSlackEnabled()).toBe(true)
    expect(isSlackWebhookEnabled()).toBe(false)

    const status = slackStatus()
    expect(status).toMatchObject({ enabled: true, webhook: false })
    expect(status.webhookReason).toContain('SLACK_SIGNING_SECRET')
    expect(status.reason).toBeUndefined()
  })
})
