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

  it('devuelve el nombre saneado que responde el modelo (sin taskId en el suffix)', async () => {
    // El prompt indica al modelo NO incluir el task ID. Verificamos que
    // aceptamos el output tal cual (solo slug + prefijo).
    const branch = await proposeLinkedBranchName(task, {
      fetch: stubFetch('feat/add-lead-invites'),
    })
    expect(branch).toBe('feat/add-lead-invites')
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

  it('el prompt user instruye al modelo a NO incluir el task ID en el nombre', async () => {
    let capturedPrompt = ''
    const capturingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ content: string }>
      }
      capturedPrompt = body.messages[0]?.content ?? ''
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'feat/add-lead-invites' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    await proposeLinkedBranchName(task, { fetch: capturingFetch })
    // Regresión: el prompt viejo pedía `<slug>-${task.id}` (que lowercaseaba
    // el node id y quedaba feo). El nuevo instruye lo contrario.
    expect(capturedPrompt).not.toContain(task.id)
    expect(capturedPrompt).toMatch(/no incluyas el task id/i)
  })

  it('inyecta system prompt claudeCodeIdentity + headers estándar (Claude Code betas)', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const capturingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {} }
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'feat/x' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await proposeLinkedBranchName(task, {
      fetch: capturingFetch,
      systemText: 'You are Claude Code, Anthropic’s official CLI for Claude.',
    })
    expect(captured).not.toBeNull()
    const c = captured!
    const headers = c.init.headers as Record<string, string>
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-beta']).toContain('claude-code-20250219')
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20')
    const body = JSON.parse(String(c.init.body)) as {
      system?: Array<{ type: string; text: string }>
    }
    expect(body.system?.[0]?.type).toBe('text')
    expect(body.system?.[0]?.text).toContain('Claude Code')
  })
})
