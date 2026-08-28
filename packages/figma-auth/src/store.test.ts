import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTokenStore, defaultSessionPath } from './store.js'

const dirs: string[] = []
async function tmpStore(): Promise<FileTokenStore> {
  const dir = await mkdtemp(join(tmpdir(), 'figma-auth-'))
  dirs.push(dir)
  return new FileTokenStore(join(dir, 'nested', 'figma-oauth.json'))
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const SESSION = {
  client: { clientId: 'cid', clientSecret: 'sec' },
  tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: 123, tokenType: 'Bearer' },
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('FileTokenStore', () => {
  it('roundtrip: crea el directorio y devuelve lo guardado', async () => {
    const store = await tmpStore()
    await store.save(SESSION)
    expect(await store.load()).toEqual(SESSION)
  })

  it('el archivo queda 0600 también al sobrescribirlo', async () => {
    const store = await tmpStore()
    await store.save(SESSION)
    await store.save({ ...SESSION, updatedAt: '2026-01-02T00:00:00.000Z' })
    const mode = (await stat(store.path)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('sin archivo devuelve null, no tira', async () => {
    const store = await tmpStore()
    expect(await store.load()).toBeNull()
  })

  it('un JSON roto se trata como ausencia de sesión', async () => {
    const store = await tmpStore()
    await store.save(SESSION)
    await writeFile(store.path, '{ esto no es json')
    expect(await store.load()).toBeNull()
  })

  it('una sesión sin accessToken no se devuelve a medias', async () => {
    const store = await tmpStore()
    await store.save(SESSION)
    await writeFile(store.path, JSON.stringify({ client: { clientId: 'c' }, tokens: {} }))
    expect(await store.load()).toBeNull()
  })

  it('clear borra y es idempotente', async () => {
    const store = await tmpStore()
    await store.save(SESSION)
    await store.clear()
    await store.clear()
    expect(await store.load()).toBeNull()
  })
})

describe('defaultSessionPath', () => {
  it('respeta IA_FLOW_CONFIG_DIR', () => {
    expect(defaultSessionPath({ IA_FLOW_CONFIG_DIR: '/opt/ia-flow' })).toBe(
      '/opt/ia-flow/figma-oauth.json',
    )
  })

  it('cae a ~/.config/ia-flow', () => {
    expect(defaultSessionPath({ HOME: '/home/j' })).toBe('/home/j/.config/ia-flow/figma-oauth.json')
  })
})
