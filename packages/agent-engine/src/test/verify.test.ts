// Unit tests for the verify gate (`runVerifyCommands` / `buildVerifyFailedError`).
// The spawn seam (`_verifyInternals.spawn`) is swapped for a controllable fake
// so timeout / truncation / exit-code paths don't need a real shell.

import { afterEach, describe, expect, it } from 'bun:test'
import {
  type SpawnedVerifyProc,
  VERIFY_FAILED_MARKER,
  VERIFY_OUTPUT_MAX_BYTES,
  _verifyInternals,
  buildVerifyFailedError,
  runVerifyCommands,
} from '../verify.js'

const REAL_SPAWN = _verifyInternals.spawn
const REAL_TIMEOUT_MS = _verifyInternals.timeoutMs

afterEach(() => {
  _verifyInternals.spawn = REAL_SPAWN
  _verifyInternals.timeoutMs = REAL_TIMEOUT_MS
})

function mockProc(
  opts: {
    stdout?: string
    stderr?: string
    exitCode?: number
    delayMs?: number
  } = {},
): SpawnedVerifyProc {
  const stdoutText = opts.stdout ?? ''
  const stderrText = opts.stderr ?? ''
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
    const delay = opts.delayMs ?? 0
    setTimeout(() => resolveExit(opts.exitCode!), delay)
  }
  return {
    stdout: mkStream(stdoutText),
    stderr: mkStream(stderrText),
    exited,
    // 143 = 128 + 15 (SIGTERM) — sólo importa que `exited` resuelva.
    kill: () => resolveExit(143),
  }
}

describe('runVerifyCommands', () => {
  it('reports ok when every command exits 0', async () => {
    _verifyInternals.spawn = () => mockProc({ stdout: 'ok\n', exitCode: 0 })
    const result = await runVerifyCommands(['bun run typecheck', 'bun test'], '/wt/task-1')
    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(2)
    expect(result.results.every((r) => r.exitCode === 0)).toBe(true)
  })

  it('stops at the first command that fails and does not run the rest', async () => {
    const seen: string[] = []
    _verifyInternals.spawn = (command) => {
      seen.push(command)
      return command.includes('typecheck')
        ? mockProc({ stderr: 'TS2345: boom\n', exitCode: 1 })
        : mockProc({ stdout: 'ok\n', exitCode: 0 })
    }
    const result = await runVerifyCommands(['bun run typecheck', 'bun test'], '/wt/task-1')
    expect(result.ok).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(seen).toEqual(['bun run typecheck'])
  })

  it('spawns each command with its raw string and the given cwd', async () => {
    let spawnedCommand: string | undefined
    let spawnedCwd: string | undefined
    _verifyInternals.spawn = (command, cwd) => {
      spawnedCommand = command
      spawnedCwd = cwd
      return mockProc({ exitCode: 0 })
    }
    await runVerifyCommands(['bun run check'], '/wt/task-1')
    expect(spawnedCommand).toBe('bun run check')
    expect(spawnedCwd).toBe('/wt/task-1')
  })

  it('captures combined stdout+stderr in the failing result', async () => {
    _verifyInternals.spawn = () => mockProc({ stdout: 'out\n', stderr: 'err\n', exitCode: 1 })
    const result = await runVerifyCommands(['bun test'], '/wt/task-1')
    expect(result.ok).toBe(false)
    expect(result.results[0].output).toContain('out')
    expect(result.results[0].output).toContain('err')
  })

  it('truncates output over the 20 KB cap with a stable marker', async () => {
    const big = 'x'.repeat(VERIFY_OUTPUT_MAX_BYTES + 500)
    _verifyInternals.spawn = () => mockProc({ stdout: big, exitCode: 1 })
    const result = await runVerifyCommands(['bun test'], '/wt/task-1')
    expect(result.results[0].output).toContain('[truncated]')
    expect(Buffer.byteLength(result.results[0].output, 'utf-8')).toBeLessThan(big.length)
  })

  it('kills the process on timeout and marks it [timeout]', async () => {
    _verifyInternals.timeoutMs = 20
    _verifyInternals.spawn = () => mockProc() // never resolves `exited` on its own
    const result = await runVerifyCommands(['sleep 999'], '/wt/task-1')
    expect(result.results[0].timedOut).toBe(true)
    expect(result.results[0].output).toContain('[timeout]')
    expect(result.ok).toBe(false)
  })

  it('does NOT mark [timeout] when the process exits naturally in time', async () => {
    _verifyInternals.timeoutMs = 5_000
    _verifyInternals.spawn = () => mockProc({ stdout: 'done\n', exitCode: 0 })
    const result = await runVerifyCommands(['ls'], '/wt/task-1')
    expect(result.results[0].timedOut).toBe(false)
    expect(result.results[0].output).not.toContain('[timeout]')
  })
})

describe('buildVerifyFailedError', () => {
  it('prefixes the message with the stable marker classifyFailure matches on', () => {
    const result = {
      ok: false,
      results: [
        { command: 'bun run typecheck', exitCode: 1, output: 'TS2345: boom', timedOut: false },
      ],
    }
    const err = buildVerifyFailedError(result, 2)
    expect(err.message.startsWith(VERIFY_FAILED_MARKER)).toBe(true)
    expect(err.message).toContain('bun run typecheck')
    expect(err.message).toContain('1/2')
    expect(err.message).toContain('TS2345: boom')
  })
})
