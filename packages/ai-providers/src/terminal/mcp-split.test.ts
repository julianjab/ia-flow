import { describe, expect, it } from 'bun:test'
import type { ProviderInput } from '../contract.js'
import { type LocalToolsMcp, resolveMcpServers } from './base.js'

const DISK = new Set(['fs_read', 'fs_write', 'bash_run'])

const localTools: LocalToolsMcp = {
  url: 'http://localhost:3002',
  token: 'host-token',
  owns: (name) => DISK.has(name),
}

function input(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    step: 'implement',
    taskId: 't1',
    taskTitle: 'x',
    taskDescription: '',
    taskType: 'functional',
    repos: [],
    repoPaths: {},
    prompt: 'p',
    runId: 'run-1',
    agentId: 'builder',
    projectId: 'proj',
    tools: ['fs_read', 'fs_write', 'memory_store', 'select_exit'],
    ...overrides,
  } as ProviderInput
}

function urlOf(servers: Record<string, unknown>, name: string): URL {
  const entry = servers[name] as { url: string } | undefined
  if (!entry) throw new Error(`falta el server '${name}'`)
  return new URL(entry.url)
}

describe('resolveMcpServers — sin agent-host (run local)', () => {
  it('sale UN solo server, con todas las tools', () => {
    // El daemon YA es esta máquina: partir la entrega no tendría sentido.
    const servers = resolveMcpServers(input(), undefined, 'http://localhost:3001', 'tok', undefined)

    expect(Object.keys(servers)).toEqual(['ia-flow-tools'])
    expect(urlOf(servers, 'ia-flow-tools').searchParams.get('tools')).toBe(
      'fs_read,fs_write,memory_store,select_exit',
    )
  })
})

describe('resolveMcpServers — detrás de un agent-host', () => {
  const servers = () =>
    resolveMcpServers(input(), undefined, 'http://daemon:3001', 'daemon-tok', localTools)

  it('las tools de disco van al agent-host y el resto al daemon', () => {
    // El punto entero del cambio: antes iba todo al daemon y un `fs_write`
    // escribía en la máquina equivocada.
    expect(urlOf(servers(), 'ia-flow-local').searchParams.get('tools')).toBe('fs_read,fs_write')
    expect(urlOf(servers(), 'ia-flow-tools').searchParams.get('tools')).toBe(
      'memory_store,select_exit',
    )
  })

  it('cada server apunta a su propio host y endpoint', () => {
    const s = servers()

    expect(urlOf(s, 'ia-flow-local').origin).toBe('http://localhost:3002')
    expect(urlOf(s, 'ia-flow-local').pathname).toBe('/v1/mcp')
    expect(urlOf(s, 'ia-flow-tools').origin).toBe('http://daemon:3001')
    expect(urlOf(s, 'ia-flow-tools').pathname).toBe('/api/mcp')
  })

  it('cada uno lleva el token de SU guard', () => {
    // El `API_AI_PROVIDER_TOKEN` del agent-host no abre el daemon, y el
    // `daemonToken` no abre el agent-host.
    const s = servers() as Record<string, { authorizationToken?: string }>

    expect(s['ia-flow-local'].authorizationToken).toBe('host-token')
    expect(s['ia-flow-tools'].authorizationToken).toBe('daemon-tok')
  })

  it('el contexto del run viaja en las DOS conexiones', () => {
    // MCP no tiene dónde colgarlo por llamada, y `/v1/mcp` necesita el `run`
    // para resolver de qué workspace se trata.
    for (const name of ['ia-flow-local', 'ia-flow-tools']) {
      const q = urlOf(servers(), name).searchParams
      expect(q.get('run')).toBe('run-1')
      expect(q.get('agent')).toBe('builder')
      expect(q.get('project')).toBe('proj')
      expect(q.get('task')).toBe('t1')
    }
  })

  it('no declara un server que no tendría ni una tool', () => {
    // El CLI pagaría el handshake para recibir una lista vacía.
    const soloDisco = resolveMcpServers(
      input({ tools: ['fs_read'] }),
      undefined,
      'http://daemon:3001',
      'daemon-tok',
      localTools,
    )
    const soloDaemon = resolveMcpServers(
      input({ tools: ['memory_store'] }),
      undefined,
      'http://daemon:3001',
      'daemon-tok',
      localTools,
    )

    expect(Object.keys(soloDisco)).toEqual(['ia-flow-local'])
    expect(Object.keys(soloDaemon)).toEqual(['ia-flow-tools'])
  })

  it('conserva los MCP configurados del agente', () => {
    const configured = { github: { type: 'http' as const, url: 'https://api.github.com/mcp' } }

    const s = resolveMcpServers(input(), configured, 'http://daemon:3001', 'tok', localTools)

    expect(Object.keys(s).sort()).toEqual(['github', 'ia-flow-local', 'ia-flow-tools'])
  })

  it('un agente sin tools no recibe ningún server sintético', () => {
    const s = resolveMcpServers(input({ tools: [] }), undefined, 'http://d:3001', 'tok', localTools)

    expect(Object.keys(s)).toEqual([])
  })
})
