import { describe, expect, it } from 'bun:test'
import { createServer } from 'node:net'
import { DEV_PROC_SPECS, isPortOpen, specById, start } from './devctl.js'

describe('DEV_PROC_SPECS', () => {
  it('trae los 4 procesos del monorepo, uno por puerto default', () => {
    expect(DEV_PROC_SPECS.map((s) => s.id)).toEqual([
      'server',
      'web',
      'agent-host-fe',
      'agent-host-be',
    ])
    const ports = DEV_PROC_SPECS.map((s) => s.defaultPort)
    expect(new Set(ports).size).toBe(ports.length)
  })

  it('specById encuentra por id y no matchea uno inexistente', () => {
    expect(specById('web')?.label).toBe('Web')
    expect(specById('no-existe')).toBeUndefined()
  })
})

describe('isPortOpen', () => {
  it('da false para un puerto que nadie escucha', async () => {
    // Alto y al azar: minimiza (sin eliminar del todo) la chance de pisar algo
    // real de la máquina que corre el test.
    await expect(isPortOpen(58231, 200)).resolves.toBe(false)
  })

  it('da true para un puerto que sí tiene algo escuchando', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      await expect(isPortOpen(port, 500)).resolves.toBe(true)
    } finally {
      server.close()
    }
  })
})

describe('start — validación (no llega a spawnear)', () => {
  it('rechaza un id de proceso desconocido', async () => {
    await expect(start('/tmp', 'no-existe', 'dev', 3001)).resolves.toEqual({
      ok: false,
      error: 'proceso desconocido: no-existe',
    })
  })

  it('rechaza un modo que no es dev/run', async () => {
    await expect(start('/tmp', 'web', 'staging' as never, 5173)).resolves.toEqual({
      ok: false,
      error: 'modo inválido: staging',
    })
  })

  it('rechaza un puerto fuera de rango', async () => {
    await expect(start('/tmp', 'web', 'dev', 0)).resolves.toEqual({
      ok: false,
      error: 'puerto inválido: 0',
    })
    await expect(start('/tmp', 'web', 'dev', 70000)).resolves.toEqual({
      ok: false,
      error: 'puerto inválido: 70000',
    })
  })

  it('rechaza un puerto que ya está ocupado por otro proceso', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const result = await start('/tmp', 'web', 'dev', port)
      expect(result).toEqual({
        ok: false,
        error: `el puerto ${port} ya está ocupado por otro proceso`,
      })
    } finally {
      server.close()
    }
  })
})
