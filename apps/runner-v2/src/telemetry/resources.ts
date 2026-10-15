/**
 * Los recursos de esta máquina para quien mira si el runner está a tope (`GET /api/resources`, y
 * lo que un host le manda a su runner): la memoria del contenedor —el tope del cgroup, que es el
 * que mata al pod, no la RAM del nodo—, la del proceso, el disco donde vive el estado, la carga
 * contra las CPUs del contenedor y cuántos worktrees de tareas hay en disco.
 *
 * Lo que no se puede leer (otro sistema, sin cgroup, un path que no existe) queda afuera: nunca
 * tira. El I/O entra por `ResourceProbe` para poder probarlo sin la máquina real.
 */
import { readdirSync, readFileSync, statfsSync } from 'node:fs'
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os'
import { join } from 'node:path'
import type { MachineResources } from '@ia-flow/shared'

export interface ResourceProbe {
  /** El contenido de un archivo, o undefined si no se puede leer. */
  read(path: string): string | undefined
  /** Las entradas de un directorio; vacío si no existe. */
  list(path: string): string[]
  statfs(path: string): { bsize: number; blocks: number; bavail: number } | undefined
  totalmem(): number
  freemem(): number
  load1(): number
  cpus(): number
  rss(): number
  now(): Date
}

const attempt = <T>(read: () => T): T | undefined => {
  try {
    return read()
  } catch {
    return undefined
  }
}

export const nodeProbe: ResourceProbe = {
  read: (path) => attempt(() => readFileSync(path, 'utf8')),
  list: (path) => attempt(() => readdirSync(path)) ?? [],
  statfs: (path) => attempt(() => statfsSync(path)),
  totalmem,
  freemem,
  load1: () => loadavg()[0] ?? 0,
  cpus: availableParallelism,
  rss: () => process.memoryUsage.rss(),
  now: () => new Date(),
}

const CGROUP = '/sys/fs/cgroup'

const number = (text: string | undefined): number | undefined => {
  const value = Number(text?.trim())
  return text !== undefined && Number.isFinite(value) ? value : undefined
}

/** Un campo de `memory.stat` (`inactive_file 1234`). */
function statField(stat: string | undefined, field: string): number {
  const line = stat?.split('\n').find((row) => row.startsWith(`${field} `))
  return number(line?.slice(field.length + 1)) ?? 0
}

/**
 * La memoria del contenedor como la cuenta Kubernetes (el working set: lo usado menos la caché de
 * archivos que se puede soltar), contra su tope. cgroup v2 y v1; sin tope, undefined.
 */
export function containerMemory(
  probe: ResourceProbe,
): { used_bytes: number; total_bytes: number } | undefined {
  const v2Max = probe.read(join(CGROUP, 'memory.max'))
  if (v2Max !== undefined) {
    const limit = number(v2Max)
    const current = number(probe.read(join(CGROUP, 'memory.current')))
    if (limit === undefined || current === undefined) return undefined
    const inactive = statField(probe.read(join(CGROUP, 'memory.stat')), 'inactive_file')
    return { used_bytes: Math.max(0, current - inactive), total_bytes: limit }
  }
  const limit = number(probe.read(join(CGROUP, 'memory', 'memory.limit_in_bytes')))
  const usage = number(probe.read(join(CGROUP, 'memory', 'memory.usage_in_bytes')))
  // Sin tope, v1 informa un número enorme: más que la máquina es "sin tope".
  if (limit === undefined || usage === undefined || limit >= probe.totalmem()) return undefined
  const inactive = statField(
    probe.read(join(CGROUP, 'memory', 'memory.stat')),
    'total_inactive_file',
  )
  return { used_bytes: Math.max(0, usage - inactive), total_bytes: limit }
}

/** Las CPUs del contenedor (`cpu.max` = cuota / período); sin tope, las de la máquina. */
export function containerCpus(probe: ResourceProbe): number {
  const [quota, period] = (probe.read(join(CGROUP, 'cpu.max')) ?? '').trim().split(/\s+/)
  const q = number(quota)
  const p = number(period)
  if (q !== undefined && p !== undefined && p > 0) return Math.round((q / p) * 100) / 100
  const v1Quota = number(probe.read(join(CGROUP, 'cpu', 'cpu.cfs_quota_us')))
  const v1Period = number(probe.read(join(CGROUP, 'cpu', 'cpu.cfs_period_us')))
  if (v1Quota !== undefined && v1Quota > 0 && v1Period) {
    return Math.round((v1Quota / v1Period) * 100) / 100
  }
  return probe.cpus()
}

/** Los worktrees de tareas bajo una raíz de workspaces: `<root>/worktrees/<repo>/.worktrees/*`. */
export function countWorktrees(root: string, probe: ResourceProbe): number {
  const base = join(root, 'worktrees')
  return probe
    .list(base)
    .reduce((total, repo) => total + probe.list(join(base, repo, '.worktrees')).length, 0)
}

export function machineResources(
  opts: { diskPath: string; worktreesRoot?: string },
  probe: ResourceProbe = nodeProbe,
): MachineResources {
  const container = containerMemory(probe)
  const memory = container
    ? { ...container, source: 'cgroup' as const }
    : {
        used_bytes: probe.totalmem() - probe.freemem(),
        total_bytes: probe.totalmem(),
        source: 'system' as const,
      }
  const fs = probe.statfs(opts.diskPath)
  return {
    at: probe.now().toISOString(),
    memory,
    process_rss_bytes: probe.rss(),
    ...(fs && fs.blocks > 0
      ? {
          disk: {
            path: opts.diskPath,
            used_bytes: (fs.blocks - fs.bavail) * fs.bsize,
            total_bytes: fs.blocks * fs.bsize,
          },
        }
      : {}),
    load: { load1: Math.round(probe.load1() * 100) / 100, cpus: containerCpus(probe) },
    ...(opts.worktreesRoot !== undefined
      ? { worktrees: countWorktrees(opts.worktreesRoot, probe) }
      : {}),
  }
}
