import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsReadTool } from '../FsReadTool.js'

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'fs-tools-fsread-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('fs_read', () => {
  it('lee el contenido de un archivo dentro de baseDir', async () => {
    await writeFile(join(baseDir, 'a.txt'), 'hola mundo', 'utf-8')
    const tool = new FsReadTool(baseDir)

    expect(await tool.handler({ path: 'a.txt' })).toBe('hola mundo')
  })

  it('rechaza un path que se escapa de baseDir', async () => {
    const tool = new FsReadTool(baseDir)
    await expect(tool.handler({ path: '../../etc/passwd' })).rejects.toThrow('fuera de baseDir')
  })

  it('tira si el archivo no existe', async () => {
    const tool = new FsReadTool(baseDir)
    await expect(tool.handler({ path: 'nope.txt' })).rejects.toThrow()
  })

  it('rechaza claves que el schema no declara', async () => {
    const tool = new FsReadTool(baseDir)

    await expect(tool.handler({ path: 'a.txt', encoding: 'latin1' })).rejects.toThrow(
      /Unrecognized key: "encoding"/,
    )
  })

  it('rechaza un FIFO en vez de colgarse esperando un writer', async () => {
    const fifoPath = join(baseDir, 'p')
    execFileSync('mkfifo', [fifoPath])
    const tool = new FsReadTool(baseDir)

    await expect(tool.handler({ path: 'p' })).rejects.toThrow('no es un archivo regular')
  })

  it('trunca por BYTES reales, no por unidad UTF-16 — un multibyte en el borde no queda partido', async () => {
    // "é" son 2 bytes en UTF-8 — un archivo de puros "é" fuerza el corte a caer justo en un
    // límite de carácter multibyte si se cuenta mal.
    const content = 'é'.repeat(150_000) // 300.000 bytes, bien por encima de MAX_BYTES (256KB)
    await writeFile(join(baseDir, 'big.txt'), content, 'utf-8')
    const tool = new FsReadTool(baseDir)

    const result = await tool.handler({ path: 'big.txt' })

    expect(result).toContain('truncado')
    // El texto devuelto (sin el mensaje de truncado) nunca debería tener MÁS bytes que el tope.
    const [text] = result.split('\n\n[truncado')
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(256 * 1024)
  })
})
