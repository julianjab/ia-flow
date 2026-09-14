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
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { join } from 'node:path'

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
  if (tracked.has(id)) return { ok: false, error: 'ya está corriendo (gestionado por esta app)' }
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
    env: { ...process.env, [spec.portEnvVar]: String(port), PATH: enrichedPath() },
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
