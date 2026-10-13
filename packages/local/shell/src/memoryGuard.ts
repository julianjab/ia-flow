import { execFile } from 'node:child_process'

/** Cuántos bytes de RSS suma el grupo de procesos `pgid` (el comando y todo lo que lanzó). */
export type GroupMemorySampler = (pgid: number) => Promise<number>

const POLL_INTERVAL_MS = 500

/** Suma el RSS (en KB, como lo imprime `ps`) de las líneas `<pgid> <rss>` que son del grupo. Puro. */
export function sumGroupRssBytes(psOutput: string, pgid: number): number {
  let kb = 0
  for (const line of psOutput.split('\n')) {
    const [group, rss] = line.trim().split(/\s+/)
    if (Number(group) === pgid) kb += Number(rss) || 0
  }
  return kb * 1024
}

/** El muestreo real: un `ps` de todos los procesos (válido igual en Linux y en macOS). */
export const psGroupSampler: GroupMemorySampler = (pgid) =>
  new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pgid=,rss='], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      // Si `ps` falla no hay dato: el guard no mata a ciegas, el timeout sigue cubriendo.
      resolve(err ? 0 : sumGroupRssBytes(stdout, pgid)),
    )
  })

export interface MemoryWatch {
  pgid: number
  maxBytes: number
  onExceeded: (usedBytes: number) => void
  sample?: GroupMemorySampler
  intervalMs?: number
}

/**
 * Vigila el RSS de un grupo de procesos y avisa UNA vez cuando pasa de `maxBytes`. Sin esto, un
 * `vitest`/`tsc` que se come la memoria del pod la agota entero: el kernel mata al runner (y con él
 * a los MCP y a las demás corridas) en vez de a ese comando. Devuelve la función que lo detiene.
 */
export function watchGroupMemory(watch: MemoryWatch): () => void {
  const { pgid, maxBytes, onExceeded, sample = psGroupSampler } = watch
  let stopped = false
  let sampling = false
  const timer = setInterval(async () => {
    if (stopped || sampling) return
    sampling = true
    try {
      const used = await sample(pgid)
      if (!stopped && used > maxBytes) {
        stopped = true
        clearInterval(timer)
        onExceeded(used)
      }
    } finally {
      sampling = false
    }
  }, watch.intervalMs ?? POLL_INTERVAL_MS)
  // El guard no puede mantener vivo el proceso del runner.
  timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
