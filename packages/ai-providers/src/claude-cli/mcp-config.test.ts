import { describe, expect, it } from 'bun:test'
import type { McpServers } from '@ia-flow/shared'
import { writeMcpConfigFile } from './mcp-config.js'

async function readJson(path: string): Promise<any> {
  return JSON.parse(await Bun.file(path).text())
}

describe('writeMcpConfigFile', () => {
  it('escribe un archivo con la forma { mcpServers } que espera --mcp-config', async () => {
    const servers: McpServers = {
      demo: { type: 'stdio', command: 'demo-mcp', args: ['--flag'] },
    }
    const path = await writeMcpConfigFile(servers)
    const parsed = await readJson(path)
    expect(parsed).toEqual({ mcpServers: { demo: { type: 'stdio', command: 'demo-mcp', args: ['--flag'] } } })
  })

  it('traduce authorizationToken a un header Bearer para entries http/sse', async () => {
    const servers: McpServers = {
      remote: { type: 'http', url: 'https://x.com/mcp', authorizationToken: 'secret-tok' },
    }
    const path = await writeMcpConfigFile(servers)
    const parsed = await readJson(path)
    expect(parsed.mcpServers.remote).toEqual({
      type: 'http',
      url: 'https://x.com/mcp',
      headers: { Authorization: 'Bearer secret-tok' },
    })
  })

  it('no pisa un header Authorization ya presente', async () => {
    const servers: McpServers = {
      remote: {
        type: 'http',
        url: 'https://x.com/mcp',
        authorizationToken: 'secret-tok',
        headers: { Authorization: 'Bearer ya-seteado' },
      },
    }
    const path = await writeMcpConfigFile(servers)
    const parsed = await readJson(path)
    expect(parsed.mcpServers.remote.headers.Authorization).toBe('Bearer ya-seteado')
  })

  it('conserva otros headers junto al Authorization derivado', async () => {
    const servers: McpServers = {
      remote: {
        type: 'sse',
        url: 'https://x.com/mcp',
        authorizationToken: 'tok',
        headers: { 'x-custom': '1' },
      },
    }
    const path = await writeMcpConfigFile(servers)
    const parsed = await readJson(path)
    expect(parsed.mcpServers.remote.headers).toEqual({ 'x-custom': '1', Authorization: 'Bearer tok' })
  })

  it('sin authorizationToken ni headers → no agrega headers', async () => {
    const servers: McpServers = { remote: { type: 'http', url: 'https://x.com/mcp' } }
    const path = await writeMcpConfigFile(servers)
    const parsed = await readJson(path)
    expect(parsed.mcpServers.remote).toEqual({ type: 'http', url: 'https://x.com/mcp' })
  })
})
