// Quick Cloudflare tunnel (`cloudflared tunnel --url http://localhost:3001`).
//
// Exists so the webhook mode is usable from a laptop: GitHub needs a public
// URL to POST to, and a quick tunnel gives one without an account or DNS.
// The daemon never depends on this — it's an operator convenience surfaced in
// the UI (General → Entorno).
//
// Lifetime is the server process: the tunnel is killed on stop() and on
// shutdown. Nothing is persisted, so a restart comes back with no tunnel (the
// trycloudflare hostname is ephemeral anyway — it changes on every start, and
// the GitHub webhook URL has to be updated each time).

import type { Subprocess } from 'bun'
import { createLogger } from '../../logger.js'

const log = createLogger('cloudflared')

export type TunnelState = 'stopped' | 'starting' | 'running' | 'error'

export interface TunnelStatus {
  state: TunnelState
  /** Public https URL once cloudflared announces it. */
  url: string | null
  /** Ready-to-paste GitHub webhook URL (`<url>/api/webhooks/github`). */
  webhookUrl: string | null
  startedAt: string | null
  error: string | null
  /** Whether the `cloudflared` binary is on PATH. */
  installed: boolean
  /** Last lines of cloudflared output — the UI shows them when start fails. */
  recentLog: string[]
}

// cloudflared announces the hostname in a banner on stderr, e.g.
//   |  https://random-words-here.trycloudflare.com                    |
const TUNNEL_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i

/** Extract the public URL from one line of cloudflared output. Exported for tests. */
export function parseTunnelUrl(line: string): string | null {
  return line.match(TUNNEL_URL_RE)?.[0] ?? null
}

/** Derive the GitHub webhook endpoint from a tunnel base URL. Exported for tests. */
export function webhookUrlFor(baseUrl: string | null): string | null {
  if (!baseUrl) return null
  return `${baseUrl.replace(/\/+$/, '')}/api/webhooks/github`
}

// Exact argv we spawn. Also used to find orphans: a SIGKILL'd parent (or a
// `bun --watch` reload, which is how dev runs) leaves the child alive, holding
// a public hostname pointed at the port we're about to reuse.
function spawnArgs(port: number): string[] {
  // --no-autoupdate: an update mid-run would restart the process and swap the
  // hostname out from under the configured GitHub webhook.
  return ['cloudflared', 'tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`]
}

/** pgrep pattern matching only tunnels this app spawned for `port`. Exported for tests. */
export function orphanPattern(port: number): string {
  return spawnArgs(port).join(' ')
}

const MAX_LOG_LINES = 40
// cloudflared usually publishes the hostname in a couple of seconds. If it
// hasn't after this long something is wrong (no network, blocked egress) —
// fail loudly instead of leaving the UI spinning forever.
const STARTUP_TIMEOUT_MS = 30_000

export class CloudflaredTunnel {
  private proc: Subprocess<'ignore', 'pipe', 'pipe'> | null = null
  private state: TunnelState = 'stopped'
  private url: string | null = null
  private startedAt: string | null = null
  private error: string | null = null
  private recentLog: string[] = []
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  // Set while stop() is tearing the process down, so the exit handler reports
  // 'stopped' instead of treating it as a crash.
  private stopping = false
  // Bumped by every start() and stop(). A start() that resumes after an await
  // and finds a newer generation aborts instead of spawning.
  private generation = 0
  private broadcast: ((msg: object) => void) | null = null

  /** Wire the WS broadcast so every state change reaches open tabs. */
  setBroadcast(fn: (msg: object) => void): void {
    this.broadcast = fn
  }

  binaryPath(): string | null {
    return Bun.which('cloudflared')
  }

  status(): TunnelStatus {
    return {
      state: this.state,
      url: this.url,
      webhookUrl: webhookUrlFor(this.url),
      startedAt: this.startedAt,
      error: this.error,
      installed: this.binaryPath() !== null,
      recentLog: [...this.recentLog],
    }
  }

  async start(port: number): Promise<TunnelStatus> {
    if (this.state === 'starting' || this.state === 'running') return this.status()
    if (!this.binaryPath()) {
      this.error = 'cloudflared no está instalado — instalalo con `brew install cloudflared`'
      this.state = 'error'
      this.emit()
      return this.status()
    }

    this.state = 'starting'
    this.url = null
    this.error = null
    this.recentLog = []
    this.startedAt = new Date().toISOString()
    this.stopping = false
    const gen = ++this.generation
    this.emit()

    await this.reapOrphans(port)
    // The button stays live while we're `starting`, so the user may have hit
    // Cerrar during that await. stop() had no process to kill; spawning now
    // would leave a tunnel open against their explicit wish.
    if (this.generation !== gen || this.stopping) return this.status()

    this.proc = Bun.spawn(spawnArgs(port), {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    log.info({ port, pid: this.proc.pid }, 'Cloudflare tunnel starting')

    void this.pump(this.proc.stdout)
    void this.pump(this.proc.stderr)
    void this.watchExit(this.proc)

    this.startupTimer = setTimeout(() => {
      if (this.state !== 'starting') return
      // Kill the process but keep the error state: a plain stop() would report
      // 'stopped' and the UI would silently go back to "cerrado" after 30s.
      void this.killProcess().then(() =>
        this.fail(`cloudflared no publicó una URL en ${STARTUP_TIMEOUT_MS / 1000}s`),
      )
    }, STARTUP_TIMEOUT_MS)

    return this.status()
  }

  /** Kill the child without touching the reported state. */
  private async killProcess(): Promise<void> {
    this.clearStartupTimer()
    const proc = this.proc
    this.proc = null
    if (!proc) return
    proc.kill()
    // Bun resolves `exited` once the process is reaped; awaiting keeps a
    // restart right after stop() from racing two cloudflared processes.
    try {
      await proc.exited
    } catch {
      /* already gone */
    }
  }

  async stop(): Promise<TunnelStatus> {
    this.stopping = true
    // Invalidate any start() still waiting on reapOrphans.
    this.generation++
    await this.killProcess()
    this.state = 'stopped'
    this.url = null
    this.startedAt = null
    this.emit()
    log.info('Cloudflare tunnel stopped')
    return this.status()
  }

  /**
   * Kill tunnels left over from a previous process. Matches our exact argv for
   * this port, so an unrelated cloudflared (a named tunnel, another port) is
   * never touched.
   */
  private async reapOrphans(port: number): Promise<void> {
    try {
      const pgrep = Bun.spawn(['pgrep', '-f', orphanPattern(port)], {
        stdout: 'pipe',
        stderr: 'ignore',
      })
      const out = await new Response(pgrep.stdout).text()
      await pgrep.exited
      const pids = out
        .split('\n')
        .map((l) => Number.parseInt(l.trim(), 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid)
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM')
          log.warn({ pid, port }, 'Reaped orphaned cloudflared from a previous run')
        } catch {
          /* already gone */
        }
      }
    } catch {
      // pgrep missing or unusable — worst case we run alongside an orphan.
    }
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    let buffered = ''
    try {
      for await (const chunk of stream) {
        buffered += decoder.decode(chunk, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines) this.onLine(line)
      }
      if (buffered) this.onLine(buffered)
    } catch {
      // Stream torn down by kill() — nothing to report.
    }
  }

  private onLine(rawLine: string): void {
    const line = rawLine.trimEnd()
    if (!line) return
    this.recentLog.push(line)
    if (this.recentLog.length > MAX_LOG_LINES) this.recentLog.shift()

    const url = parseTunnelUrl(line)
    if (url && this.url !== url) {
      this.url = url
      this.state = 'running'
      this.clearStartupTimer()
      log.info({ url, webhookUrl: webhookUrlFor(url) }, 'Cloudflare tunnel ready')
      this.emit()
    }
  }

  private async watchExit(proc: Subprocess<'ignore', 'pipe', 'pipe'>): Promise<void> {
    const code = await proc.exited
    if (this.proc !== proc) return // superseded by a newer start()
    this.proc = null
    if (this.stopping) return // stop() already reported the final state
    this.fail(`cloudflared terminó inesperadamente (exit ${code})`)
  }

  private fail(message: string): void {
    this.clearStartupTimer()
    this.state = 'error'
    this.error = message
    this.url = null
    log.warn({ message, recentLog: this.recentLog.slice(-5) }, 'Cloudflare tunnel failed')
    this.emit()
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
  }

  private emit(): void {
    this.broadcast?.({ type: 'tunnel:status', ...this.status() })
  }
}

export const tunnel = new CloudflaredTunnel()
