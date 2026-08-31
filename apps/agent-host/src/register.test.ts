import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Log } from './logger.js'
import { registerSelf } from './register.js'

const ENV_KEYS = [
  'IA_FLOW_REGISTER_SERVER_URLS',
  'IA_FLOW_AGENT_HOST_PUBLIC_URL',
  'API_AI_PROVIDER_TOKEN',
  'IA_FLOW_PROVIDER_NAME',
  'IA_FLOW_REGISTER_RETRIES',
  'IA_FLOW_REGISTER_RETRY_DELAY_MS',
  'IA_FLOW_SERVER_TOKEN',
] as const

const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = Bun.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete Bun.env[k]
    else Bun.env[k] = originalEnv[k]
  }
})

function silentLog(): Log {
  // `child` devuelve el MISMO stub: la interfaz `Log` la exige, y encadenarlo
  // tiene que seguir dando algo silencioso.
  const log: Log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  }
  return log
}

// retries:1/delay:0 por default en los tests que no ejercitan el retry en sí
// — evita que un test de "falla y no reintenta más" tarde segundos de
// verdad esperando el IA_FLOW_REGISTER_RETRY_DELAY_MS default (2000ms).
function setEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete Bun.env[k]
  Bun.env.IA_FLOW_REGISTER_RETRIES = '1'
  Bun.env.IA_FLOW_REGISTER_RETRY_DELAY_MS = '0'
  for (const [k, v] of Object.entries(overrides)) Bun.env[k] = v
}

describe('registerSelf', () => {
  it('sin IA_FLOW_REGISTER_SERVER_URLS → no hace ningún fetch', async () => {
    setEnv({})
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      throw new Error('no debería llamarse')
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })
    expect(calls).toBe(0)
  })

  it('con servers pero sin publicUrl/token/name → no hace fetch (solo warn)', async () => {
    setEnv({ IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001' })
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      throw new Error('no debería llamarse')
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })
    expect(calls).toBe(0)
  })

  it('no borra nada si el alta entra limpia — la vieja sólo estorba si el server dice 409', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
    })

    const methods: string[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      return new Response(JSON.stringify({ registration: { id: 'fresh-1' } }), { status: 201 })
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })

    expect(methods).toEqual(['POST'])
  })

  it('un 409 (ya existe una con este name) borra la vieja y reintenta', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
    })

    const calls: Array<{ url: string; method: string }> = []
    let posts = 0
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'POST') {
        posts++
        return posts === 1
          ? new Response(JSON.stringify({ error: 'ya existe' }), { status: 409 })
          : new Response(JSON.stringify({ registration: { id: 'fresh-1' } }), { status: 201 })
      }
      if (method === 'DELETE') return new Response(null, { status: 200 })
      return new Response(
        JSON.stringify({ registrations: [{ id: 'stale-1', name: 'julianbuitrago-mac' }] }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const [result] = await registerSelf({ log: silentLog(), fetchImpl })

    expect(result?.ok).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'DELETE', 'POST'])
  })

  it('un alta que falla NO borra la que ya andaba', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
      IA_FLOW_REGISTER_RETRIES: '1',
    })

    // El caso real: el server no puede alcanzar la publicUrl que le mandamos
    // (típico cuando corre en un container y le decimos "localhost").
    const methods: string[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      return new Response(JSON.stringify({ error: 'no se pudo alcanzar' }), { status: 400 })
    }) as unknown as typeof fetch

    const [result] = await registerSelf({ log: silentLog(), fetchImpl })

    expect(result?.ok).toBe(false)
    expect(methods).not.toContain('DELETE')
  })

  it('publicUrl pisa la del entorno — dos servers pueden ver esta máquina distinto', async () => {
    setEnv({
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
    })

    let sent: { baseUrl?: string } = {}
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') sent = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ registration: { id: 'x' } }), { status: 201 })
    }) as unknown as typeof fetch

    await registerSelf({
      log: silentLog(),
      fetchImpl,
      serverUrls: ['http://localhost:3011'],
      publicUrl: 'http://host.containers.internal:3002',
    })

    expect(sent.baseUrl).toBe('http://host.containers.internal:3002')
  })

  it('registra contra varios servers (comma-separated)', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://a.example.com, http://b.example.com',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
    })

    const posted: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method === undefined) {
        return new Response(JSON.stringify({ registrations: [] }), { status: 200 })
      }
      if (init.method === 'POST') {
        posted.push(url)
        return new Response(JSON.stringify({ registration: { id: 'x' } }), { status: 201 })
      }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })

    expect(posted).toEqual([
      'http://a.example.com/api/provider-registrations',
      'http://b.example.com/api/provider-registrations',
    ])
  })

  it('un server que falla (network error) no frena el registro contra el resto', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://caido.example.com,http://ok.example.com',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
    })

    const posted: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.startsWith('http://caido.example.com')) throw new Error('ECONNREFUSED')
      if (init?.method === undefined) {
        return new Response(JSON.stringify({ registrations: [] }), { status: 200 })
      }
      if (init.method === 'POST') {
        posted.push(url)
        return new Response(JSON.stringify({ registration: { id: 'x' } }), { status: 201 })
      }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })

    expect(posted).toEqual(['http://ok.example.com/api/provider-registrations'])
  })

  it('POST no-2xx → loguea warn y sigue (no lanza)', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
    })
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === undefined) {
        return new Response(JSON.stringify({ registrations: [] }), { status: 200 })
      }
      return new Response('boom', { status: 500 })
    }) as unknown as typeof fetch

    const results = await registerSelf({ log: silentLog(), fetchImpl })
    expect(results.every((r) => !r.ok)).toBe(true)
  })

  it('reintenta hasta IA_FLOW_REGISTER_RETRIES veces y se recupera si un intento posterior anda', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
      IA_FLOW_REGISTER_RETRIES: '3',
      IA_FLOW_REGISTER_RETRY_DELAY_MS: '0',
    })

    let postAttempts = 0
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === undefined) {
        return new Response(JSON.stringify({ registrations: [] }), { status: 200 })
      }
      if (init.method === 'POST') {
        postAttempts++
        // Los primeros dos intentos fallan (server todavía no está listo,
        // caso típico de arranque en frío en compose) — el tercero anda.
        if (postAttempts < 3) return new Response('server not ready', { status: 503 })
        return new Response(JSON.stringify({ registration: { id: 'x' } }), { status: 201 })
      }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })

    expect(postAttempts).toBe(3)
  })

  it('agota todos los intentos si nunca anda → no lanza, no hace más de IA_FLOW_REGISTER_RETRIES POSTs', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
      IA_FLOW_REGISTER_RETRIES: '3',
      IA_FLOW_REGISTER_RETRY_DELAY_MS: '0',
    })

    let postAttempts = 0
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === undefined) {
        return new Response(JSON.stringify({ registrations: [] }), { status: 200 })
      }
      if (init.method === 'POST') {
        postAttempts++
        return new Response('boom', { status: 500 })
      }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const results = await registerSelf({ log: silentLog(), fetchImpl })
    expect(results.every((r) => !r.ok)).toBe(true)
    expect(postAttempts).toBe(3)
  })
})

describe('registerSelf — no dejar al operador peor que antes', () => {
  it('si el reemplazo falla, repone la registración que borró', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3011',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
      IA_FLOW_REGISTER_RETRIES: '1',
    })

    // La que ya andaba se dio de alta con una URL que este agent-host no puede
    // adivinar (una IP de la LAN), y hoy ninguna de las que prueba funciona:
    // el escenario donde el fallback automático no salva el día.
    const BUENA = 'http://192.168.1.50:3002'
    const posts: Array<{ baseUrl: string }> = []
    let deleted = false
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        const body = JSON.parse(init?.body as string) as { baseUrl: string }
        posts.push(body)
        if (body.baseUrl === BUENA) {
          return new Response(JSON.stringify({ registration: { id: 'restored' } }), { status: 201 })
        }
        return deleted
          ? new Response(JSON.stringify({ error: 'no se pudo alcanzar' }), { status: 400 })
          : new Response(JSON.stringify({ error: 'ya existe' }), { status: 409 })
      }
      if (method === 'DELETE') {
        deleted = true
        return new Response(null, { status: 200 })
      }
      return new Response(
        JSON.stringify({
          registrations: [{ id: 'buena', name: 'julianbuitrago-mac', baseUrl: BUENA }],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const [result] = await registerSelf({ log: silentLog(), fetchImpl })

    // El alta que se pidió falló, y eso se reporta...
    expect(result?.ok).toBe(false)
    // ...pero la que venía andando se repuso. No se mira el último POST
    // porque después de reponer todavía se prueban las URLs alternativas.
    expect(posts.map((p) => p.baseUrl)).toContain(BUENA)
  })
})

describe('registerSelf — una sola URL alcanza', () => {
  it('si el server no nos alcanza por localhost, reintenta con host.containers.internal', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3011',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
      IA_FLOW_REGISTER_RETRIES: '1',
    })

    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST')
        return new Response(JSON.stringify({ registrations: [] }), { status: 200 })
      const { baseUrl } = JSON.parse(init.body as string) as { baseUrl: string }
      // El server corre en un container: sólo alcanza a su host por ese nombre.
      return baseUrl.includes('host.containers.internal')
        ? new Response(JSON.stringify({ registration: { id: 'ok' } }), { status: 201 })
        : new Response(JSON.stringify({ error: `no se pudo alcanzar ${baseUrl}` }), { status: 400 })
    }) as unknown as typeof fetch

    const [result] = await registerSelf({ log: silentLog(), fetchImpl })

    expect(result?.ok).toBe(true)
    // Y se reporta con cuál quedó, que es lo que la pantalla muestra.
    expect(result?.publicUrl).toBe('http://host.containers.internal:3002')
  })

  it('no reescribe un host que alguien puso a propósito', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3011',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://192.168.1.50:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
      IA_FLOW_REGISTER_RETRIES: '1',
    })

    const tried: string[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST')
        return new Response(JSON.stringify({ registrations: [] }), { status: 200 })
      tried.push((JSON.parse(init.body as string) as { baseUrl: string }).baseUrl)
      return new Response(JSON.stringify({ error: 'no se pudo alcanzar' }), { status: 400 })
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })

    expect(tried).toEqual(['http://192.168.1.50:3002'])
  })
})

describe('registerSelf — la URL no es de un server', () => {
  it('un 401 se lee como "ahí no hay un server", y no se reintenta', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3002',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
      IA_FLOW_REGISTER_RETRIES: '5',
    })

    // El caso real: poner la URL del agent-host en el campo del server. Se
    // registra contra sí mismo y su propio auth contesta 401 a todo.
    let posts = 0
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts++
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    }) as unknown as typeof fetch

    const [result] = await registerSelf({ log: silentLog(), fetchImpl })

    expect(result?.notAServer).toBe(true)
    expect(result?.reason).toContain('no parece un server de ia-flow')
    // Ni los 5 reintentos ni las URLs alternativas: nada de eso cambiaría.
    expect(posts).toBe(1)
  })
})

describe('registerSelf — server con la API protegida', () => {
  it('con IA_FLOW_SERVER_TOKEN, las tres llamadas al server llevan x-ia-flow-token', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://runner:3001',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://agent-host:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'frontend',
      IA_FLOW_SERVER_TOKEN: 'secreto-del-server',
    })

    // Por el camino del 409, que es el único que ejercita las tres verbos: si
    // el GET o el DELETE viajan sin credencial, `findExisting` recibe 401,
    // devuelve [] y el 409 no se puede resolver nunca.
    const seen: Array<{ method: string; token: string | null }> = []
    let posts = 0
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ method, token: headers['x-ia-flow-token'] ?? null })
      if (method === 'POST') {
        posts++
        return posts === 1
          ? new Response(JSON.stringify({ error: 'ya existe' }), { status: 409 })
          : new Response(JSON.stringify({ registration: { id: 'fresh-1' } }), { status: 201 })
      }
      if (method === 'DELETE') return new Response(null, { status: 200 })
      return new Response(
        JSON.stringify({ registrations: [{ id: 'stale-1', name: 'frontend' }] }),
        {
          status: 200,
        },
      )
    }) as unknown as typeof fetch

    const [result] = await registerSelf({ log: silentLog(), fetchImpl })

    expect(result?.ok).toBe(true)
    expect(seen.map((c) => c.method)).toEqual(['POST', 'GET', 'DELETE', 'POST'])
    expect(seen.every((c) => c.token === 'secreto-del-server')).toBe(true)
  })

  it('sin IA_FLOW_SERVER_TOKEN no se manda el header — un server sin auth sigue igual', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'frontend',
    })

    let sawHeader = true
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      sawHeader = 'x-ia-flow-token' in headers
      return new Response(JSON.stringify({ registration: { id: 'r-1' } }), { status: 201 })
    }) as unknown as typeof fetch

    const [result] = await registerSelf({ log: silentLog(), fetchImpl })

    expect(result?.ok).toBe(true)
    expect(sawHeader).toBe(false)
  })

  it('un 401 CON token mandado no es "ahí no hay un server": es la credencial', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://runner:3001',
      IA_FLOW_AGENT_HOST_PUBLIC_URL: 'http://agent-host:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'frontend',
      IA_FLOW_SERVER_TOKEN: 'el-viejo',
      IA_FLOW_REGISTER_RETRIES: '2',
    })

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
      })) as unknown as typeof fetch

    const [result] = await registerSelf({ log: silentLog(), fetchImpl })

    expect(result?.ok).toBe(false)
    // Lo que importa: NO se descarta el server. `notAServer` corta los
    // reintentos y hace que la UI ni siquiera recuerde la URL.
    expect(result?.notAServer).toBeUndefined()
    expect(result?.reason).toContain('IA_FLOW_SERVER_TOKEN')
  })
})
