import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BashRunTool, memoryNote } from '../BashRunTool.js'

let baseDir: string

beforeEach(async () => {
  baseDir = await realpath(await mkdtemp(join(tmpdir(), 'shell-tools-memory-')))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

const MB = 1024 ** 2

describe('bash_run — tope de memoria', () => {
  it('mata el comando y dice que fue por memoria cuando el grupo pasa del tope', async () => {
    const tool = new BashRunTool({
      baseDir,
      policy: { deny: [] },
      maxMemoryBytes: 512 * MB,
      memorySampler: async () => 900 * MB,
    })

    const start = Date.now()
    const result = JSON.parse(await tool.handler({ command: 'sleep 30' }))

    expect(Date.now() - start).toBeLessThan(5_000)
    expect(result.status).toBe(
      'memoria: se cortó al pasar de 512 MB (usaba 900 MB); corré una parte más chica',
    )
  }, 10_000)

  it('un comando bajo el tope termina normal', async () => {
    const tool = new BashRunTool({
      baseDir,
      policy: { deny: [] },
      maxMemoryBytes: 512 * MB,
      memorySampler: async () => 10 * MB,
    })

    const result = JSON.parse(await tool.handler({ command: 'echo hola' }))

    expect(result.status).toBe('exit 0')
  })

  it('el modelo lee el tope en la descripción (default 2048 MB)', () => {
    expect(new BashRunTool({ baseDir, policy: { deny: [] } }).description).toContain('2048 MB')
    expect(memoryNote({ maxMemoryBytes: 256 * MB })).toContain('256 MB')
  })
})
