import { describe, expect, it } from 'bun:test'
import { hostResources } from '../providers/remoteHosts.js'
import {
  containerCpus,
  containerMemory,
  countWorktrees,
  machineResources,
  type ResourceProbe,
} from './resources.js'

const GiB = 1024 ** 3

/** Una máquina falsa: archivos y directorios por path. */
function probe(
  files: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
  patch: Partial<ResourceProbe> = {},
): ResourceProbe {
  return {
    read: (path) => files[path],
    list: (path) => dirs[path] ?? [],
    statfs: () => ({ bsize: 4096, blocks: 1000, bavail: 250 }),
    totalmem: () => 64 * GiB,
    freemem: () => 16 * GiB,
    load1: () => 1.234,
    cpus: () => 8,
    rss: () => 300 * 1024 ** 2,
    now: () => new Date('2026-10-15T12:00:00Z'),
    ...patch,
  }
}

describe('containerMemory', () => {
  it('cgroup v2: el working set (sin la caché de archivos) contra memory.max', () => {
    const p = probe({
      '/sys/fs/cgroup/memory.max': `${4 * GiB}\n`,
      '/sys/fs/cgroup/memory.current': `${3 * GiB}\n`,
      '/sys/fs/cgroup/memory.stat': `anon 123\ninactive_file ${GiB}\nactive_file 5\n`,
    })
    expect(containerMemory(p)).toEqual({ used_bytes: 2 * GiB, total_bytes: 4 * GiB })
  })

  it('cgroup v2 sin tope (`max`): no hay memoria del contenedor', () => {
    const p = probe({ '/sys/fs/cgroup/memory.max': 'max\n', '/sys/fs/cgroup/memory.current': '1' })
    expect(containerMemory(p)).toBeUndefined()
  })

  it('cgroup v1: el tope, salvo que sea más que la máquina (sin tope)', () => {
    const limited = probe({
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': `${2 * GiB}`,
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${GiB}`,
      '/sys/fs/cgroup/memory/memory.stat': `total_inactive_file ${GiB / 2}`,
    })
    expect(containerMemory(limited)).toEqual({ used_bytes: GiB / 2, total_bytes: 2 * GiB })
    const unlimited = probe({
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${GiB}`,
    })
    expect(containerMemory(unlimited)).toBeUndefined()
  })
})

describe('containerCpus', () => {
  it('la cuota del cgroup; sin cuota, las de la máquina', () => {
    expect(containerCpus(probe({ '/sys/fs/cgroup/cpu.max': '150000 100000\n' }))).toBe(1.5)
    expect(containerCpus(probe({ '/sys/fs/cgroup/cpu.max': 'max 100000\n' }))).toBe(8)
    expect(
      containerCpus(
        probe({
          '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '200000',
          '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
        }),
      ),
    ).toBe(2)
    expect(containerCpus(probe({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1' }))).toBe(8)
  })
})

describe('machineResources', () => {
  it('cuenta los worktrees de cada repo', () => {
    const p = probe(
      {},
      {
        '/w/worktrees': ['front', 'back'],
        '/w/worktrees/front/.worktrees': ['task-1', 'task-2'],
        '/w/worktrees/back/.worktrees': ['task-3'],
      },
    )
    expect(countWorktrees('/w', p)).toBe(3)
    expect(countWorktrees('/nada', p)).toBe(0)
  })

  it('sin cgroup: la memoria de la máquina; el disco del path; la carga contra las CPUs', () => {
    expect(machineResources({ diskPath: '/state', worktreesRoot: '/w' }, probe())).toEqual({
      at: '2026-10-15T12:00:00.000Z',
      memory: { used_bytes: 48 * GiB, total_bytes: 64 * GiB, source: 'system' },
      process_rss_bytes: 300 * 1024 ** 2,
      disk: { path: '/state', used_bytes: 750 * 4096, total_bytes: 1000 * 4096 },
      load: { load1: 1.23, cpus: 8 },
      worktrees: 0,
    })
  })

  it('lo que no se puede leer queda afuera (sin disco, sin worktrees)', () => {
    const resources = machineResources(
      { diskPath: '/no-existe' },
      probe({}, {}, { statfs: () => undefined }),
    )
    expect(resources.disk).toBeUndefined()
    expect(resources.worktrees).toBeUndefined()
    expect(resources.memory?.source).toBe('system')
  })
})

describe('hostResources', () => {
  it('cada host con sus lugares; sus recursos sólo si cumplen el contrato', () => {
    const base = {
      provider: 'remote:x',
      maxConcurrent: 2,
      running: 1,
      accepts: [],
      lastSeen: '2026-10-15T12:00:00.000Z',
    }
    const [good, bad, none] = hostResources([
      { ...base, name: 'a', stats: { at: '2026-10-15T12:00:00.000Z', worktrees: 4 } },
      { ...base, name: 'b', stats: { at: 12 } },
      { ...base, name: 'c' },
    ])
    expect(good).toEqual({
      name: 'a',
      provider: 'remote:x',
      max_concurrent: 2,
      running: 1,
      last_seen: '2026-10-15T12:00:00.000Z',
      resources: { at: '2026-10-15T12:00:00.000Z', worktrees: 4 },
    })
    expect(bad?.resources).toBeUndefined()
    expect(none?.resources).toBeUndefined()
  })
})
