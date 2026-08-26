import { describe, expect, it } from 'bun:test'
import { githubAuthConfigFromEnv } from './config.js'

const MISSING = '/tmp/ia-flow-no-existe-esta-key.pem'

describe('githubAuthConfigFromEnv', () => {
  it('default: auto y el PAT del env', () => {
    const cfg = githubAuthConfigFromEnv({ GITHUB_TOKEN: 'ghp_1' })
    expect(cfg.mode).toBe('auto')
    expect(cfg.token).toBe('ghp_1')
  })

  it('la key inline gana sobre el path', () => {
    const cfg = githubAuthConfigFromEnv({
      IA_FLOW_GITHUB_APP_PRIVATE_KEY: 'inline',
      IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH: MISSING,
    })
    expect(cfg.privateKey).toBe('inline')
  })

  it('un .pem ilegible NO se lleva puestas las otras estrategias en auto', () => {
    // Este throw saldría de `readConfig()`, ANTES del factory, así que el guard
    // de `buildApp` no alcanzaba: un path mal escrito rompía también el PAT y
    // el gh CLI que sí funcionaban.
    const cfg = githubAuthConfigFromEnv({
      IA_FLOW_GITHUB_APP_ID: '1',
      IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH: MISSING,
      GITHUB_TOKEN: 'ghp_1',
    })
    expect(cfg.privateKey).toBeUndefined()
    expect(cfg.token).toBe('ghp_1')
  })

  it('en el modo github-app explícito, un .pem ilegible sí grita', () => {
    expect(() =>
      githubAuthConfigFromEnv({
        IA_FLOW_GITHUB_AUTH_MODE: 'github-app',
        IA_FLOW_GITHUB_APP_ID: '1',
        IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH: MISSING,
      }),
    ).toThrow(/PRIVATE_KEY_PATH/)
  })

  it('trata una variable declarada pero vacía como ausente', () => {
    const cfg = githubAuthConfigFromEnv({ GITHUB_TOKEN: '  ', IA_FLOW_GITHUB_APP_ID: '' })
    expect(cfg.token).toBeUndefined()
    expect(cfg.appId).toBeUndefined()
  })
})
