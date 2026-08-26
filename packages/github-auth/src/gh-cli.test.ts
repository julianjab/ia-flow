import { describe, expect, it } from 'bun:test'
import { type CommandRunner, GhCliCredentials } from './gh-cli.js'

function runner(responses: Record<string, { code: number; stdout: string; stderr?: string }>) {
  const calls: string[][] = []
  const run: CommandRunner = async (cmd) => {
    calls.push(cmd)
    const res = responses[cmd.join(' ')] ?? { code: 1, stdout: '', stderr: 'unexpected' }
    return { code: res.code, stdout: res.stdout, stderr: res.stderr ?? '' }
  }
  return { run, calls }
}

describe('GhCliCredentials', () => {
  it('devuelve el token que imprime `gh auth token`', async () => {
    const { run } = runner({ 'gh auth token': { code: 0, stdout: 'gho_xyz\n' } })
    expect(await new GhCliCredentials({ run }).getToken()).toBe('gho_xyz')
  })

  it('cachea para no spawnear un proceso por request', async () => {
    const { run, calls } = runner({ 'gh auth token': { code: 0, stdout: 'gho_xyz' } })
    const creds = new GhCliCredentials({ run })
    await creds.getToken()
    await creds.getToken()
    expect(calls.length).toBe(1)
  })

  it('devuelve undefined —no tira— cuando gh no está autenticado', async () => {
    // Fail-open hacia "sin credencial": en modo auto esto es sólo la señal de
    // pasar a la siguiente estrategia, no un error del sistema.
    const { run } = runner({ 'gh auth token': { code: 1, stdout: '', stderr: 'not logged in' } })
    const creds = new GhCliCredentials({ run })
    expect(await creds.getToken()).toBeUndefined()
    expect(await creds.isAvailable()).toBe(false)
  })

  it('devuelve undefined cuando `gh` no está instalado', async () => {
    const run: CommandRunner = async () => {
      throw new Error('ENOENT')
    }
    expect(await new GhCliCredentials({ run }).getToken()).toBeUndefined()
  })

  it('resuelve el login para mostrarlo en describe()', async () => {
    const { run } = runner({
      'gh auth token': { code: 0, stdout: 'gho_xyz' },
      'gh api user --jq .login': { code: 0, stdout: 'julianjab\n' },
    })
    const creds = new GhCliCredentials({ run })
    await creds.probeIdentity()
    expect(creds.describe()).toEqual({ mode: 'gh-cli', identity: 'julianjab' })
  })
})
