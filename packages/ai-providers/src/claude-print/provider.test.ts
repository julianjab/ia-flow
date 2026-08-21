import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProviderInput } from '../contract.js'
import { ClaudePrintProvider, type SpawnedProc, _claudePrintInternals } from './provider.js'

const REAL_SPAWN = _claudePrintInternals.spawn

afterEach(() => {
  _claudePrintInternals.spawn = REAL_SPAWN
})

function mockProc(
  opts: { stdout?: string; stderr?: string; exitCode?: number; delayMs?: number } = {},
): SpawnedProc {
  const mkStream = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        if (text) controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    })
  let resolveExit: (code: number) => void = () => {}
  const exited = new Promise<number>((r) => {
    resolveExit = r
  })
  if (opts.exitCode !== undefined) {
    setTimeout(() => resolveExit(opts.exitCode!), opts.delayMs ?? 0)
  }
  return {
    stdout: mkStream(opts.stdout ?? ''),
    stderr: mkStream(opts.stderr ?? ''),
    exited,
    kill: () => resolveExit(143),
  }
}

function baseInput(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    step: 'implement',
    taskId: 't1',
    taskTitle: 'Add login',
    taskDescription: 'desc',
    taskType: 'functional',
    repos: [],
    repoPaths: {},
    prompt: 'do the thing',
    ...overrides,
  }
}

function logSpy() {
  const info: unknown[] = []
  const warn: unknown[] = []
  return { info: (o: object) => info.push(o), warn: (o: object) => warn.push(o), infoCalls: info, warnCalls: warn }
}

describe('ClaudePrintProvider', () => {
  let capturedArgv: string[] = []
  let capturedCwd: string | undefined

  beforeEach(() => {
    capturedArgv = []
    capturedCwd = undefined
  })

  it('id/kind/name', () => {
    const provider = new ClaudePrintProvider({ log: logSpy() })
    expect(provider.id).toBe('claude-print')
    expect(provider.kind).toBe('sync')
  })

  it('corre `claude -p <prompt>` y devuelve stdout como content', async () => {
    _claudePrintInternals.spawn = (argv, cwd) => {
      capturedArgv = argv
      capturedCwd = cwd
      return mockProc({ stdout: 'listo\n', exitCode: 0 })
    }
    const provider = new ClaudePrintProvider({ log: logSpy() })
    const output = await provider.run(baseInput({ cwd: '/repo' }))

    expect(capturedArgv).toEqual(['claude', '-p', 'do the thing'])
    expect(capturedCwd).toBe('/repo')
    expect(output).toEqual({ content: 'listo', mode: 'api', stopReason: 'end_turn' })
  })

  it('prepende systemPromptBlocks al prompt final', async () => {
    _claudePrintInternals.spawn = (argv) => {
      capturedArgv = argv
      return mockProc({ stdout: 'ok', exitCode: 0 })
    }
    const provider = new ClaudePrintProvider({ log: logSpy() })
    await provider.run(
      baseInput({ systemPromptBlocks: [{ type: 'text', text: 'sos un agente útil' }] }),
    )

    expect(capturedArgv[2]).toBe('sos un agente útil\n\ndo the thing')
  })

  it('agrega --model y --dangerously-skip-permissions desde providerConfig', async () => {
    _claudePrintInternals.spawn = (argv) => {
      capturedArgv = argv
      return mockProc({ stdout: 'ok', exitCode: 0 })
    }
    const provider = new ClaudePrintProvider({ log: logSpy() })
    await provider.run(
      baseInput({ providerConfig: { model: 'claude-opus-4-7', dangerouslySkipPermissions: true } }),
    )

    expect(capturedArgv).toEqual([
      'claude',
      '-p',
      'do the thing',
      '--model',
      'claude-opus-4-7',
      '--dangerously-skip-permissions',
    ])
  })

  it('exit code != 0 → stopReason error, usa stdout si hay, si no stderr', async () => {
    _claudePrintInternals.spawn = () => mockProc({ stderr: 'boom\n', exitCode: 1 })
    const provider = new ClaudePrintProvider({ log: logSpy() })
    const output = await provider.run(baseInput())

    expect(output.stopReason).toBe('error')
    expect(output.content).toBe('boom')
  })

  it('exit code != 0 sin stdout ni stderr → mensaje generico con el codigo', async () => {
    _claudePrintInternals.spawn = () => mockProc({ exitCode: 7 })
    const provider = new ClaudePrintProvider({ log: logSpy() })
    const output = await provider.run(baseInput())

    expect(output.content).toBe('claude -p exited with code 7')
  })

  it('signal abortado → mata el proceso', async () => {
    let killed = false
    _claudePrintInternals.spawn = () => {
      const proc = mockProc({ stdout: 'never', exitCode: 0, delayMs: 50 })
      return { ...proc, kill: () => { killed = true; return undefined } }
    }
    const controller = new AbortController()
    const provider = new ClaudePrintProvider({ log: logSpy() })
    const promise = provider.run(baseInput({ signal: controller.signal }))
    controller.abort()
    await promise
    expect(killed).toBe(true)
  })
})
