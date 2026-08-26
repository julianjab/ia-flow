import { describe, expect, it } from 'bun:test'
import { StaticCredentials } from './static.js'

describe('StaticCredentials', () => {
  it('devuelve el token configurado', async () => {
    const creds = new StaticCredentials('ghp_abc')
    expect(await creds.getToken()).toBe('ghp_abc')
    expect(creds.describe()).toEqual({ mode: 'static', identity: 'static-token' })
    expect(creds.configured).toBe(true)
  })

  it('trata una variable declarada pero vacía como ausente', async () => {
    // El caso real: un `.env` con `GITHUB_TOKEN=` — sin esto, `auto` elegiría
    // esta estrategia y todas las llamadas fallarían con 401.
    const creds = new StaticCredentials('   ')
    expect(await creds.getToken()).toBeUndefined()
    expect(creds.configured).toBe(false)
    expect(creds.describe().identity).toBeUndefined()
  })
})
