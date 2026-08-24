// Descubre qué servers ia-flow hay vivos en esta máquina, para que el
// launcher (/Applications/IA Flow.app) pueda ofrecerlos en un selector sin
// que nadie mantenga una lista a mano.
//
// Un "server" acá es cualquier cosa que responda 200 en GET /api/projects:
// da igual si es `bun run dev:server` en el host o un container de runners/*.
// Los containers se enriquecen con su nombre y su carpeta de compose para
// poder arrancarlos si están apagados.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './paths.ts'

export type ServerTarget = {
  /** baseUrl por el que ESTE proceso (host) alcanza el server. */
  url: string
  port: number
  label: string
  alive: boolean
  /** Seteado sólo si el server vive dentro de un container. */
  container?: { name: string; running: boolean; composeDir: string | null }
}

const DEFAULT_PORTS = [3001, 3011, 3020]
const PROBE_TIMEOUT_MS = 900

type ContainerInfo = { name: string; running: boolean; hostPorts: number[] }

function sh(cmd: string[]): string {
  try {
    const out = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'ignore' })
    return out.success ? out.stdout.toString() : ''
  } catch {
    return ''
  }
}

/** Containers de podman/docker con su mapeo de puertos al host. */
function listContainers(): ContainerInfo[] {
  const raw = sh(['podman', 'ps', '-a', '--format', 'json'])
  if (!raw.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed.flatMap((c) => {
    const rec = c as Record<string, unknown>
    const names = rec.Names
    const name = Array.isArray(names) ? String(names[0]) : String(rec.Name ?? '')
    if (!name) return []
    const ports = Array.isArray(rec.Ports) ? rec.Ports : []
    const hostPorts = ports
      .map((p) => Number((p as Record<string, unknown>).host_port))
      .filter((n) => Number.isInteger(n) && n > 0)
    const running = String(rec.State ?? '').toLowerCase() === 'running'
    return [{ name, running, hostPorts }]
  })
}

/**
 * Carpeta de compose de un container, resuelta leyendo los runners/* del
 * repo (no los labels del container: así también encontramos la carpeta de
 * un runner que nunca se levantó en esta máquina).
 */
function composeDirFor(containerName: string): string | null {
  const runnersDir = join(REPO_ROOT, 'runners')
  let entries: string[]
  try {
    entries = readdirSync(runnersDir)
  } catch {
    return null
  }
  for (const entry of entries) {
    const dir = join(runnersDir, entry)
    for (const file of ['docker-compose.yml', 'docker-compose.yaml']) {
      try {
        const text = readFileSync(join(dir, file), 'utf8')
        const match = text.match(/^\s*container_name:\s*(\S+)\s*$/m)
        if (match?.[1] === containerName) return dir
      } catch {
        // ese runner no tiene ese archivo — seguimos
      }
    }
  }
  return null
}

/** Puertos TCP en LISTEN, para descubrir servers que no están en la lista fija. */
function listeningPorts(): number[] {
  const raw = sh(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'])
  const ports = new Set<number>()
  for (const line of raw.split('\n')) {
    if (!line.startsWith('n')) continue
    const match = line.match(/:(\d+)$/)
    if (!match) continue
    const port = Number(match[1])
    // Rango donde viven los servers/gateways de ia-flow — evita sondear los
    // 200 puertos random que tenga abiertos el resto del sistema.
    if (port >= 3000 && port <= 3099) ports.add(port)
  }
  return [...ports]
}

async function probe(port: number): Promise<{ ok: boolean; projects: string[] }> {
  try {
    const res = await fetch(`http://localhost:${port}/api/projects`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, projects: [] }
    const body = (await res.json()) as { projects?: { id?: string }[] }
    if (!Array.isArray(body.projects)) return { ok: false, projects: [] }
    const projects = body.projects.map((p) => String(p.id ?? '')).filter(Boolean)
    return { ok: true, projects }
  } catch {
    return { ok: false, projects: [] }
  }
}

function labelFor(port: number, projects: string[], container?: ContainerInfo): string {
  if (container) return `${container.name.replace(/^ia-flow-/, '')} · container :${port}`
  const named = projects.filter((p) => p !== 'local')
  if (named.length > 0) return `${named.join(', ')} · host :${port}`
  return `server local :${port}`
}

/**
 * Todos los servers ia-flow que esta máquina puede ofrecer: los que responden
 * ahora mismo, más los containers de runners/* que están apagados (para poder
 * arrancarlos desde el launcher en vez de mandar al usuario a la terminal).
 */
export async function discoverServers(): Promise<ServerTarget[]> {
  const containers = listContainers()
  const byPort = new Map<number, ContainerInfo>()
  for (const c of containers) for (const p of c.hostPorts) byPort.set(p, c)

  const candidates = new Set<number>([...DEFAULT_PORTS, ...listeningPorts(), ...byPort.keys()])
  const probed = await Promise.all(
    [...candidates].map(async (port) => ({ port, ...(await probe(port)) })),
  )

  const found: ServerTarget[] = []
  for (const { port, ok, projects } of probed) {
    if (!ok) continue
    const container = byPort.get(port)
    found.push({
      url: `http://localhost:${port}`,
      port,
      label: labelFor(port, projects, container),
      alive: true,
      container: container
        ? { name: container.name, running: true, composeDir: composeDirFor(container.name) }
        : undefined,
    })
  }

  // Containers apagados: no responden, pero el launcher sabe encenderlos.
  for (const c of containers) {
    if (c.running) continue
    const composeDir = composeDirFor(c.name)
    if (!composeDir) continue
    const port = c.hostPorts.find((p) => p >= 3000 && p <= 3099)
    if (!port || found.some((f) => f.port === port)) continue
    found.push({
      url: `http://localhost:${port}`,
      port,
      label: `${c.name.replace(/^ia-flow-/, '')} · container :${port} (apagado)`,
      alive: false,
      container: { name: c.name, running: false, composeDir },
    })
  }

  return found.sort((a, b) => Number(b.alive) - Number(a.alive) || a.port - b.port)
}

/** ¿Sigue vivo el server que guardamos la vez pasada? */
export async function isAlive(url: string): Promise<boolean> {
  const port = Number(new URL(url).port)
  if (!Number.isInteger(port)) return false
  return (await probe(port)).ok
}
