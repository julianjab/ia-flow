// Control de los procesos de dev locales (server, web, los dos agent-host)
// desde la app.
//
// Separado de main.ts por el mismo motivo que servers-store.ts: es lógica
// testeable sin levantar Electron — spawnea y mata procesos con
// node:child_process, no toca ipcMain ni BrowserWindow.
//
// Reintroduce lo que el README de esta app decía explícitamente que NO hacía
// ("no levanta procesos"). Esa decisión seguía siendo correcta para lo que
// resolvía — dos apps que hacían lo mismo (servir la SPA) fusionadas en una—,
// pero el pedido ahora es otro: reemplazar 4 terminales abiertas a mano
// (server, web, agent-host de frontend, agent-host de backend e2e) por un
// panel en la misma app, con el modo (`dev`/`run`) y el puerto elegidos por
// el operador. Ver el README actualizado.

import type { ChildProcess } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type DevMode = 'dev' | 'run'

export interface DevProcSpec {
  id: string
  label: string
  /** Relativo a la raíz del repo. */
  cwd: string
  /** Env var que ese proceso lee para elegir su puerto. */
  portEnvVar: string
  defaultPort: number
  /** Comando por modo, ejecutado con `sh -c` — admite cadenas (`build && preview`). */
  commands: Record<DevMode, string>
}

/**
 * Los 4 procesos del monorepo. Hardcodeado y no editable desde la UI a
 * propósito: son los mismos 4 de siempre (ver la tabla de puertos del
 * CLAUDE.md raíz) — lo que el operador elige por proceso es el modo y el
 * puerto, no qué comando corre.
 */
export const DEV_PROC_SPECS: readonly DevProcSpec[] = [
  {
    id: 'server',
    label: 'Server',
    cwd: 'apps/server',
    portEnvVar: 'IA_FLOW_SERVER_PORT',
    defaultPort: 3001,
    commands: { dev: 'bun run dev', run: 'bun run start' },
  },
  {
    id: 'web',
    label: 'Web',
    cwd: 'apps/web',
    portEnvVar: 'IA_FLOW_WEB_PORT',
    defaultPort: 5173,
    // `run` necesita el build antes: `preview` sirve `dist/`, no compila.
    commands: { dev: 'bun run dev', run: 'bun run build && bun run preview' },
  },
  {
    id: 'agent-host-fe',
    label: 'Agent Host · frontend',
    cwd: 'apps/agent-host',
    portEnvVar: 'PORT',
    defaultPort: 3002,
    commands: { dev: 'bun run dev ./agent-host.yaml', run: 'bun run start ./agent-host.yaml' },
  },
  {
    id: 'agent-host-be',
    label: 'Agent Host · backend e2e',
    cwd: 'apps/agent-host',
    portEnvVar: 'PORT',
    defaultPort: 3003,
    commands: {
      dev: 'bun run dev ./agent-host.backend.yaml',
      run: 'bun run start ./agent-host.backend.yaml',
    },
  },
]

export function specById(id: string): DevProcSpec | undefined {
  return DEV_PROC_SPECS.find((s) => s.id === id)
}

interface TrackedProc {
  child: ChildProcess
  mode: DevMode
  port: number
  startedAt: number
  /** Últimas líneas de stdout+stderr, para diagnosticar sin abrir una terminal. */
  logTail: string[]
  lastExit: { code: number | null; signal: NodeJS.Signals | null } | null
}

const MAX_LOG_LINES = 300

/** Módulo, no una clase: un solo proceso Electron, un solo registry — mismo
 *  criterio que el `child` suelto de main.ts. */
const tracked = new Map<string, TrackedProc>()

function pushLog(t: TrackedProc, chunk: string): void {
  for (const line of chunk.split('\n')) {
    if (line) t.logTail.push(line)
  }
  if (t.logTail.length > MAX_LOG_LINES) t.logTail.splice(0, t.logTail.length - MAX_LOG_LINES)
}

/**
 * Mismo chequeo que `isPortTaken`/`connects` de main.ts — duplicado a
 * propósito: ese vive del lado de Electron (usa `app`) y este módulo no
 * depende de él para poder testearse sin levantar la app.
 */
function connects(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export async function isPortOpen(port: number, timeoutMs = 600): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1']) {
    if (await connects(host, port, timeoutMs)) return true
  }
  return false
}

export interface DevProcStatus {
  id: string
  label: string
  defaultPort: number
  /** `true` sólo si ESTA app lo levantó — es lo único que se puede parar desde acá. */
  managed: boolean
  /** Hay algo escuchando en el puerto vigente, gestionado por nosotros o no —
   *  distingue "libre para levantar" de "ya hay algo ahí" aunque no sea
   *  nuestro (otra terminal, un deploy local viejo). */
  portOpen: boolean
  mode: DevMode | null
  port: number | null
  pid: number | null
  startedAt: number | null
  lastExit: { code: number | null; signal: NodeJS.Signals | null } | null
}

export async function statusOf(spec: DevProcSpec): Promise<DevProcStatus> {
  const t = tracked.get(spec.id)
  const port = t?.port ?? spec.defaultPort
  const portOpen = await isPortOpen(port)
  return {
    id: spec.id,
    label: spec.label,
    defaultPort: spec.defaultPort,
    managed: !!t,
    portOpen,
    mode: t?.mode ?? null,
    port: t ? t.port : null,
    pid: t?.child.pid ?? null,
    startedAt: t?.startedAt ?? null,
    lastExit: t?.lastExit ?? null,
  }
}

export async function statusAll(): Promise<DevProcStatus[]> {
  return Promise.all(DEV_PROC_SPECS.map(statusOf))
}

export function logsOf(id: string): string[] {
  return tracked.get(id)?.logTail ?? []
}

export type DevctlResult = { ok: true } | { ok: false; error: string }

/**
 * El PATH completo con `.bun/bin` y Homebrew — una app abierta desde el
 * Finder arranca con el PATH del sistema, sin ellos. Mismo criterio que
 * `startChild` en main.ts.
 */
function enrichedPath(): string {
  return [
    join(process.env.HOME ?? '', '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env.PATH ?? '',
  ].join(':')
}

const LHTB_TIMEOUT_MS = 5_000

/** `lhtb` puede vivir en Homebrew o `~/.local/bin` — el PATH mínimo con el
 *  que arranca la app desde el Finder no alcanza para encontrarlo, mismo
 *  motivo que `enrichedPath()` existe para el `spawn` de abajo. */
function lhtbExecOpts() {
  return { env: { ...process.env, PATH: enrichedPath() }, timeout: LHTB_TIMEOUT_MS }
}

const LHTB_CACHE_TTL_MS = 5 * 60_000

let lhtbEnvCache: { at: number; promise: Promise<Record<string, string>> } | null = null

/**
 * Secretos administrados por `lhtb meta envs` (macOS Keychain) que faltan en
 * el env de esta app — abierta desde el Finder no hereda el shell del
 * operador, así que `GITHUB_TOKEN`/`SLACK_BOT_TOKEN`/etc. suelen faltar acá
 * aunque estén en el Keychain. `process.env` siempre gana en `start`; esto
 * sólo rellena huecos con lo que `lhtb meta envs list` diga que administra —
 * ninguna lista hardcodeada, para no desincronizarse si el toolbox agrega o
 * saca un secreto.
 *
 * Sin `lhtb` instalado, o sin ese secreto en el Keychain, esto NO bloquea el
 * start: el proceso arranca igual, sin esa var — mismo comportamiento que
 * antes de que esto existiera. `timeout` en cada llamada es la contraparte:
 * un lookup que se cuelga (Keychain bloqueado, pidiendo el password de
 * login) no puede trabar `start()` para siempre.
 *
 * El cache tiene TTL, no vive para siempre: un resultado vacío o parcial por
 * cualquier motivo transitorio (login keychain bloqueado, `security` negando
 * el acceso puntual) se reintenta solo a los 5' en vez de quedar pegado hasta
 * reiniciar la app.
 */
async function lhtbEnv(): Promise<Record<string, string>> {
  const stale = !lhtbEnvCache || Date.now() - lhtbEnvCache.at > LHTB_CACHE_TTL_MS
  if (stale) {
    const promise = resolveLhtbEnv().catch((err) => {
      lhtbEnvCache = null
      throw err
    })
    lhtbEnvCache = { at: Date.now(), promise }
  }
  return (lhtbEnvCache as NonNullable<typeof lhtbEnvCache>).promise.catch(() => ({}))
}

const VALID_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

async function resolveLhtbEnv(): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync('lhtb', ['meta', 'envs', 'list'], lhtbExecOpts())
  const names = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => VALID_ENV_NAME.test(l))

  const env: Record<string, string> = {}
  // Serial, no `Promise.all`: cada lectura pasa por `/usr/bin/security`, y
  // lanzarlas todas juntas puede disparar varios diálogos de Keychain a la
  // vez si el ACL no autoriza la lectura silenciosa.
  for (const name of names) {
    if (process.env[name]?.trim()) continue
    try {
      const { stdout } = await execFileAsync('lhtb', ['meta', 'envs', 'get', name], lhtbExecOpts())
      const value = stdout.trim()
      if (value) env[name] = value
    } catch (err) {
      // Un `get` que sale con error de proceso (timeout, matado, sin
      // spawnear) casi siempre significa Keychain bloqueado — TODOS los
      // `get` restantes fallarían igual, así que cortamos y dejamos que
      // `lhtbEnv()` no cachee nada, en vez de gastar `timeout * N` en
      // reintentos que van a fallar. Un exit no-cero simple (`no encontrado`)
      // es la ausencia esperada de un secreto puntual: se saltea y sigue.
      const proc = err as { killed?: boolean; signal?: string | null; code?: unknown }
      // Un exit-code numérico es "no encontrado" (falla esperada, puntual).
      // `killed`/`signal` (timeout) o un `code` no-numérico (ENOENT: no se
      // pudo ni spawnear `lhtb`) son infra rota — no vale la pena seguir.
      if (proc.killed || proc.signal || typeof proc.code !== 'number') throw err
    }
  }
  return env
}

/** Ids con un `start` en curso, entre el chequeo de `tracked` y el
 *  `tracked.set` de más abajo — esa ventana ahora cruza dos `await`
 *  (`isPortOpen`, `lhtbEnv`) que pueden tardar segundos con el Keychain
 *  bloqueado. Sin esto, dos `start` superpuestos del mismo id pasan los dos
 *  el chequeo y levantan dos procesos; el segundo pisa la entrada del
 *  primero en `tracked` y lo deja huérfano, sin forma de pararlo. */
const starting = new Set<string>()

export async function start(
  repoRoot: string,
  id: string,
  mode: DevMode,
  port: number,
): Promise<DevctlResult> {
  const spec = specById(id)
  if (!spec) return { ok: false, error: `proceso desconocido: ${id}` }
  if (mode !== 'dev' && mode !== 'run') return { ok: false, error: `modo inválido: ${mode}` }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `puerto inválido: ${port}` }
  }
  if (tracked.has(id) || starting.has(id)) {
    return { ok: false, error: 'ya está corriendo (gestionado por esta app)' }
  }
  starting.add(id)

  try {
    if (await isPortOpen(port)) {
      return { ok: false, error: `el puerto ${port} ya está ocupado por otro proceso` }
    }

    // `detached: true` para poder matar por GRUPO en `stop` (pid negativo): el
    // comando real es `sh -c '<comando>'`, y el `run` de la web es una cadena
    // (`build && preview`) — matar sólo el `sh` de arriba deja el proceso real
    // huérfano, el mismo problema que ya describe el comentario de `startChild`
    // en main.ts para el caso más simple de un solo comando.
    const child = spawn('/bin/sh', ['-c', spec.commands[mode]], {
      cwd: join(repoRoot, spec.cwd),
      // `process.env` primero, `lhtbEnv()` encima: `lhtbEnv()` sólo trae
      // nombres que YA estaban vacíos/ausentes en `process.env` (mismo
      // chequeo `?.trim()`), así que aplicarlo después nunca pisa un valor
      // real — sólo tapa el hueco. Al revés, un `GITHUB_TOKEN=""` heredado
      // (variable exportada vacía) volvía a ganarle al valor del Keychain.
      env: {
        ...process.env,
        ...(await lhtbEnv()),
        [spec.portEnvVar]: String(port),
        PATH: enrichedPath(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    const t: TrackedProc = { child, mode, port, startedAt: Date.now(), logTail: [], lastExit: null }
    tracked.set(id, t)

    child.stdout?.on('data', (d) => pushLog(t, String(d)))
    child.stderr?.on('data', (d) => pushLog(t, String(d)))
    child.on('exit', (code, signal) => {
      t.lastExit = { code, signal }
      tracked.delete(id)
    })
    child.on('error', (err) => {
      pushLog(t, `[devctl] spawn error: ${String(err)}`)
      t.lastExit = { code: null, signal: null }
      tracked.delete(id)
    })

    return { ok: true }
  } finally {
    starting.delete(id)
  }
}

export function stop(id: string): DevctlResult {
  const t = tracked.get(id)
  if (!t) return { ok: false, error: 'no está gestionado por esta app' }
  const pid = t.child.pid
  if (pid === undefined) return { ok: false, error: 'sin pid — no se puede matar' }
  try {
    // Grupo, no el proceso individual — ver el comentario de `start`.
    process.kill(-pid, 'SIGTERM')
  } catch (err) {
    return { ok: false, error: String(err) }
  }
  return { ok: true }
}

/**
 * Mata todo lo que esta app haya levantado. Mismo motivo que `killChild` en
 * main.ts: un `kill`/`pkill` a Electron no dispara `before-quit`, y sin esto
 * quedan procesos huérfanos ocupando los puertos en el próximo arranque.
 */
export function stopAll(): void {
  for (const id of [...tracked.keys()]) stop(id)
}
