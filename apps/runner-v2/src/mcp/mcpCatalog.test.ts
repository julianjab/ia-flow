import { afterEach, describe, expect, it } from 'bun:test'
import { resolveMcpCatalog } from './mcpCatalog.js'

let local: ReturnType<typeof Bun.serve> | undefined
afterEach(() => {
  local?.stop(true)
  local = undefined
  delete process.env.TEST_FIGMA_TOKEN
})

const auth = { getToken: async () => 'ghs_test' }
const figma = {
  id: 'figma-mcp',
  config: {
    type: 'http' as const,
    // La pública: este mismo runner, que al resolver el catálogo todavía no escucha.
    url: 'http://127.0.0.1:1/mcp/figma',
    authorizationToken: '${TEST_FIGMA_TOKEN}',
    hosted: 'figma',
  },
}

describe('resolveMcpCatalog: the GitHub token', () => {
  it('is resolved on every call, and `force` drops the cached one first', async () => {
    local = Bun.serve({ port: 0, fetch: () => new Response('{}') })
    // Una App de mentira: `invalidate` descarta el token, y el próximo es otro.
    let issued = 1
    let invalidated = 0
    const app = {
      getToken: async () => `ghs_${issued}`,
      invalidate: () => {
        invalidated++
        issued++
      },
    }
    const github = {
      id: 'github-mcp',
      config: {
        type: 'http' as const,
        url: `http://127.0.0.1:${local.port}/mcp`,
        authorizationToken: '${GITHUB_TOKEN}',
      },
    }
    const catalog = await resolveMcpCatalog([github], app, [])
    const token = catalog['github-mcp']?.config.authorizationToken as (options?: {
      force?: boolean
    }) => Promise<string>

    expect(await token()).toBe('ghs_1')
    expect(await token({ force: true })).toBe('ghs_2')
    expect(invalidated).toBe(1)
  })
})

describe('resolveMcpCatalog with hosted MCPs', () => {
  it('probes a hosted MCP against its local process and keeps the public url for the agents', async () => {
    process.env.TEST_FIGMA_TOKEN = 'secreto'
    const seen: Array<string | null> = []
    local = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers.get('authorization'))
        return new Response('{}')
      },
    })
    const warnings: string[] = []
    const catalog = await resolveMcpCatalog([figma], auth, warnings, (id) =>
      id === 'figma' ? `http://127.0.0.1:${local?.port}/mcp` : undefined,
    )
    expect(warnings).toEqual([])
    expect(seen).toEqual([null])
    expect(catalog['figma-mcp']?.config.url).toBe('http://127.0.0.1:1/mcp/figma')
    const token = catalog['figma-mcp']?.config.authorizationToken
    expect(typeof token === 'function' ? await token() : token).toBe('secreto')
  })

  it('leaves out a hosted MCP whose mcpHost is not published, with a warning', async () => {
    process.env.TEST_FIGMA_TOKEN = 'secreto'
    const warnings: string[] = []
    const catalog = await resolveMcpCatalog([figma], auth, warnings, () => undefined)
    expect(catalog).toEqual({})
    expect(warnings).toEqual([
      'mcp "figma-mcp": el mcpHost "figma" no está publicado — los agentes corren sin él',
    ])
  })
})
