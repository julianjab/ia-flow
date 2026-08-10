import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { proposeLinkedBranchName, sanitizeBranchName } from './branch-namer.js'

// buildAnthropicAuthHeader tira si no hay auth; en test forzamos una key ficticia
// para que la rama "call API" del código se ejerza — el fetch está stubbed.
let restoreKey: string | undefined
beforeAll(() => {
  restoreKey = Bun.env.ANTHROPIC_API_KEY
  Bun.env.ANTHROPIC_API_KEY = 'test-key'
})
afterAll(() => {
  if (restoreKey === undefined) delete Bun.env.ANTHROPIC_API_KEY
  else Bun.env.ANTHROPIC_API_KEY = restoreKey
})

// Stub fetch: firma compatible con globalThis.fetch, devuelve una Response ok
// con el `text` en el content[0].text.
function stubFetch(text: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('sanitizeBranchName', () => {
  it('convierte a lowercase y kebab-case', () => {
    expect(sanitizeBranchName('Feat/Add Lead Invites')).toBe('feat/add-lead-invites')
  })

  it('quita acentos, comillas y markdown residual', () => {
    expect(sanitizeBranchName('`feat/añadir-configuración`')).toBe('feat/a-adir-configuraci-n')
  })

  it('colapsa dobles guiones y slashes', () => {
    expect(sanitizeBranchName('feat//add--lead')).toBe('feat/add-lead')
  })

  it('trimea guiones y slashes de bordes', () => {
    expect(sanitizeBranchName('///-feat/add-')).toBe('feat/add')
  })

  it('devuelve vacío cuando el input no tiene chars válidos', () => {
    expect(sanitizeBranchName('****')).toBe('')
  })

  it('trunca a 80 chars', () => {
    const long = 'a'.repeat(200)
    expect(sanitizeBranchName(long).length).toBeLessThanOrEqual(80)
  })
})

describe('proposeLinkedBranchName', () => {
  const task = {
    id: 'ABC123',
    title: 'Add lead invites flow',
    description: 'Los usuarios pueden invitar leads con un token único',
    type: 'functional',
  }

  it('devuelve el nombre saneado que responde el modelo', async () => {
    const branch = await proposeLinkedBranchName(task, {
      fetch: stubFetch('feat/add-lead-invites-ABC123'),
    })
    expect(branch).toBe('feat/add-lead-invites-abc123')
  })

  it('cae al fallback cuando el API responde 500', async () => {
    const branch = await proposeLinkedBranchName(task, { fetch: stubFetch('boom', 500) })
    expect(branch).toBe('task/ABC123')
  })

  it('cae al fallback cuando el modelo responde texto vacío / basura sin chars válidos', async () => {
    const branch = await proposeLinkedBranchName(task, { fetch: stubFetch('!!!!') })
    expect(branch).toBe('task/ABC123')
  })

  it('cae al fallback cuando fetch throwea', async () => {
    const failingFetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const branch = await proposeLinkedBranchName(task, { fetch: failingFetch })
    expect(branch).toBe('task/ABC123')
  })
})
