// Unit tests for the verify gate (`runVerifyCommands` / `buildVerifyFailedError`).
// The spawn seam (`_verifyInternals.spawn`) is swapped for a controllable fake
// so timeout / truncation / exit-code paths don't need a real shell.

import { afterEach, describe, expect, it } from 'bun:test'
import {
  _verifyInternals,
  buildVerifyEnv,
  buildVerifyFailedError,
  runVerifyCommands,
  type SpawnedVerifyProc,
  VERIFY_FAILED_MARKER,
  VERIFY_OUTPUT_MAX_BYTES,
} from '../verify.js'

const REAL_SPAWN = _verifyInternals.spawn
const REAL_TIMEOUT_MS = _verifyInternals.timeoutMs
const REAL_GRACE_MS = _verifyInternals.graceMs

afterEach(() => {
  _verifyInternals.spawn = REAL_SPAWN
  _verifyInternals.timeoutMs = REAL_TIMEOUT_MS
  _verifyInternals.graceMs = REAL_GRACE_MS
})

function mockProc(
  opts: { stdout?: string; stderr?: string; exitCode?: number; delayMs?: number } = {},
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

  it('un binario ausente (Bun.spawn tira sync) se reporta como fallo, no como excepción sin marcar', async () => {
    _verifyInternals.spawn = () => {
      throw new Error('Executable not found in $PATH: "bunx"')
    }
    const result = await runVerifyCommands(['bunx tsc'], '/wt/task-1')
    expect(result.ok).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].exitCode).toBeNull()
    expect(result.results[0].output).toContain('Executable not found')
  })

  it('stops at the first command that fails and does not run the rest', async () => {
    const seen: string[][] = []
    _verifyInternals.spawn = (argv) => {
      seen.push(argv)
      return argv.includes('typecheck')
        ? mockProc({ stderr: 'TS2345: boom\n', exitCode: 1 })
        : mockProc({ stdout: 'ok\n', exitCode: 0 })
    }
    const result = await runVerifyCommands(['bun run typecheck', 'bun test'], '/wt/task-1')
    expect(result.ok).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(seen).toEqual([['bun', 'run', 'typecheck']])
  })

  it('spawns each command as argv (no shell) with the given cwd', async () => {
    let spawnedArgv: string[] | undefined
    let spawnedCwd: string | undefined
    _verifyInternals.spawn = (argv, cwd) => {
      spawnedArgv = argv
      spawnedCwd = cwd
      return mockProc({ exitCode: 0 })
    }
    await runVerifyCommands(['bun run check'], '/wt/task-1')
    expect(spawnedArgv).toEqual(['bun', 'run', 'check'])
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

  // Regression: kill() sólo termina el proceso directo. Un nieto que sigue
  // vivo (tsc detrás de `bun run typecheck`, workers de vitest) sostiene el
  // pipe de stdout heredado abierto para siempre — antes de HARD_DEADLINE_
  // GRACE_MS, `Response(stream).text()` esperaba ese cierre y `runOne` nunca
  // resolvía, colgando el run entero y reteniendo su lock indefinidamente.
  it('resuelve dentro del deadline duro aunque el stdout nunca cierre tras el kill', async () => {
    _verifyInternals.timeoutMs = 10
    _verifyInternals.graceMs = 30
    const neverClosingStdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial output del nieto\n'))
        // Deliberadamente nunca se cierra — simula un nieto vivo.
      },
    })
    _verifyInternals.spawn = () => ({
      stdout: neverClosingStdout,
      stderr: null,
      exited: new Promise<number>(() => {}), // tampoco resuelve nunca
      kill: () => {},
    })
    const started = Date.now()
    const result = await runVerifyCommands(['bun run typecheck'], '/wt/task-1')
    const elapsedMs = Date.now() - started
    expect(elapsedMs).toBeLessThan(2_000)
    expect(result.ok).toBe(false)
    expect(result.results[0].timedOut).toBe(true)
    expect(result.results[0].output).toContain('partial output del nieto')
    expect(result.results[0].exitCode).toBeNull()
  })
})

describe('buildVerifyEnv', () => {
  it('drops names that look like a credential, keeps the rest', () => {
    const env = buildVerifyEnv({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ghp_x',
      ANTHROPIC_API_KEY: 'sk-x',
      SLACK_BOT_TOKEN: 'xoxb-x',
      DB_PASSWORD: 'x',
      npm_config_registry: 'https://registry.npmjs.org',
    })
    expect(env).toEqual({ PATH: '/usr/bin', npm_config_registry: 'https://registry.npmjs.org' })
  })

  it('drops undefined values without throwing', () => {
    expect(buildVerifyEnv({ PATH: undefined, HOME: '/home/x' })).toEqual({ HOME: '/home/x' })
  })

  it('is case-insensitive on the secret-pattern match', () => {
    expect(buildVerifyEnv({ myAuthHeader: 'x', OK: 'y' })).toEqual({ OK: 'y' })
  })

  it('keeps SSH_AUTH_SOCK — infra de git/ssh, no un secreto, aunque matchee "auth"', () => {
    expect(buildVerifyEnv({ SSH_AUTH_SOCK: '/tmp/ssh.sock', OK: 'y' })).toEqual({
      SSH_AUTH_SOCK: '/tmp/ssh.sock',
      OK: 'y',
    })
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
