import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { LocalToolsMcp } from '../claude-cli/tools-mcp.js'
import type { ProviderInput } from '../contract.js'
import { _claudePrintInternals, ClaudePrintProvider, type SpawnedProc } from './provider.js'

const REAL_SPAWN = _claudePrintInternals.spawn
afterEach(() => {
  _claudePrintInternals.spawn = REAL_SPAWN
})

function mockProc(exitCode = 0): SpawnedProc {
  const empty = (): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start: (c) => c.close(),
    })
  let resolveExit: (code: number) => void = () => {}
  const exited = new Promise<number>((r) => {
    resolveExit = r
  })
  setTimeout(() => resolveExit(exitCode), 0)
  return { stdout: empty(), stderr: empty(), exited, kill: () => resolveExit(143) }
}

const silentLog = { info: () => {}, warn: () => {} }

const DISK = new Set(['fs_read', 'bash_run'])
const localTools: LocalToolsMcp = {
  url: 'http://localhost:3002',
  token: 'host-token',
  owns: (name: string) => DISK.has(name),
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
    daemonUrl: 'http://daemon:3001',
    daemonToken: 'daemon-tok',
    tools: ['fs_read', 'memory_store'],
    ...overrides,
  }
}

/** Corre el provider y devuelve el `--mcp-config` que le pasó al CLI. */
async function mcpConfigOf(
  provider: ClaudePrintProvider,
  inp: ProviderInput,
): Promise<Record<string, { url: string; authorizationToken?: string }>> {
  let written: Record<string, { url: string; authorizationToken?: string }> = {}
  _claudePrintInternals.spawn = (argv) => {
    const idx = argv.indexOf('--mcp-config')
    if (idx !== -1) {
      const parsed = JSON.parse(readFileSync(argv[idx + 1]!, 'utf-8'))
      written = parsed.mcpServers ?? parsed
    }
    return mockProc()
  }
  await provider.run(inp)
  return written
}

describe('claude-print — entrega de tools', () => {
  it('las tools del agente llegan como MCP: antes su `tools[]` se ignoraba entero', async () => {
    // Un CLI no acepta definiciones inyectadas; su única puerta es
    // `--mcp-config`. Sin esto, un agente con tools corría sin ninguna.
    const servers = await mcpConfigOf(new ClaudePrintProvider({ log: silentLog }), input())

    expect(Object.keys(servers)).toContain('ia-flow-tools')
  })

  it('con agent-host, las de disco van al MCP local y el resto al daemon', async () => {
    const provider = new ClaudePrintProvider({ log: silentLog, localTools: () => localTools })

    const servers = await mcpConfigOf(provider, input())

    expect(new URL(servers['ia-flow-local']!.url).origin).toBe('http://localhost:3002')
    expect(new URL(servers['ia-flow-local']!.url).searchParams.get('tools')).toBe('fs_read')
    expect(new URL(servers['ia-flow-tools']!.url).origin).toBe('http://daemon:3001')
    expect(new URL(servers['ia-flow-tools']!.url).searchParams.get('tools')).toBe('memory_store')
  })

  it('declara `kind=sync` — este run lo cierra el engine, no `complete_task`', async () => {
    // Ofrecerle un cierre propio le sacaría la task del registry a mitad del
    // run, mientras el engine todavía espera su `stopReason`.
    const servers = await mcpConfigOf(new ClaudePrintProvider({ log: silentLog }), input())

    expect(new URL(servers['ia-flow-tools']!.url).searchParams.get('kind')).toBe('sync')
  })

  it('un agente sin tools no recibe ningún MCP sintético', async () => {
    const servers = await mcpConfigOf(
      new ClaudePrintProvider({ log: silentLog }),
      input({ tools: [] }),
    )

    expect(Object.keys(servers)).toEqual([])
  })
})

describe('claude-print — el timeout', () => {
  it('sin `timeoutMs` no corta el run', async () => {
    // Eran 10 minutos clavados: vencido, el proceso moría y volvía
    // `stopReason: 'error'` con el stdout parcial — un fallo inventado sobre
    // trabajo que estaba avanzando. Quién espera cuánto lo decide el engine.
    let killed = false
    _claudePrintInternals.spawn = () => {
      const proc = mockProc()
      return { ...proc, kill: () => (killed = true) }
    }

    const out = await new ClaudePrintProvider({ log: silentLog }).run(input({ tools: [] }))

    expect(killed).toBe(false)
    expect(out.stopReason).toBe('end_turn')
  })

  it('`timeoutMs: 0` tampoco — es "sin límite", como los caps del engine', async () => {
    let killed = false
    _claudePrintInternals.spawn = () => ({ ...mockProc(), kill: () => (killed = true) })

    await new ClaudePrintProvider({ log: silentLog, timeoutMs: 0 }).run(input({ tools: [] }))

    expect(killed).toBe(false)
  })

  it('con un `timeoutMs` explícito sí mata el proceso', async () => {
    let killed = false
    _claudePrintInternals.spawn = () => {
      // No resuelve solo: sólo el timeout puede terminarlo.
      const empty = (): ReadableStream<Uint8Array> =>
        new ReadableStream({ start: (c) => c.close() })
      let resolveExit: (code: number) => void = () => {}
      const exited = new Promise<number>((r) => {
        resolveExit = r
      })
      return {
        stdout: empty(),
        stderr: empty(),
        exited,
        kill: () => {
          killed = true
          resolveExit(143)
        },
      }
    }

    await new ClaudePrintProvider({ log: silentLog, timeoutMs: 5 }).run(input({ tools: [] }))

    expect(killed).toBe(true)
  })
})
