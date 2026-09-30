import axios from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeBaseUrl, probeServer } from '../api'

const BASE = 'http://localhost:3001'

const runnerInfo = {
  service: 'ia-flow-runner',
  version: '2.0.0',
  projects: [{ id: 'p1', board: { owner: 'acme', number: 3 } }],
  github_login: { device_flow: true },
  assistant: true,
}

function mockGet(impl: (url: string) => unknown) {
  return vi.spyOn(axios, 'get').mockImplementation(async (url: string) => impl(url) as never)
}

describe('probeServer', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reconoce un runner-v2 con UNA sola request a /api/runner', async () => {
    const get = mockGet(() => ({ data: runnerInfo }))

    const probed = await probeServer(BASE, 'tok')

    expect(probed).toMatchObject({
      kind: 'runner',
      reachable: true,
      needsToken: false,
      version: '2.0.0',
      deviceFlow: true,
      assistant: true,
    })
    expect(probed.projects).toHaveLength(1)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0]?.[0]).toBe(`${BASE}/api/runner`)
    expect(get.mock.calls[0]?.[1]).toMatchObject({ headers: { 'x-ia-flow-token': 'tok' } })
  })

  it('un 401 es "pide token", no "no responde"', async () => {
    mockGet(() => {
      throw { response: { status: 401 } }
    })
    const probed = await probeServer(BASE)
    expect(probed).toMatchObject({ reachable: false, needsToken: true, kind: 'unknown' })
  })

  it('un fallo de red es "no responde"', async () => {
    mockGet(() => {
      throw new Error('ECONNREFUSED')
    })
    const probed = await probeServer(BASE)
    expect(probed).toMatchObject({ reachable: false, needsToken: false })
  })

  it('algo que no es un runner (HTML del fallback, un v1) no se da por vivo', async () => {
    mockGet(() => ({ data: '<!doctype html>' }))
    expect((await probeServer(BASE)).reachable).toBe(false)
    mockGet(() => ({ data: { projects: [] } }))
    expect((await probeServer(BASE)).kind).toBe('unknown')
  })
})

describe('normalizeBaseUrl', () => {
  it('agrega esquema y saca la barra final', () => {
    expect(normalizeBaseUrl('localhost:3001/')).toBe('http://localhost:3001')
    expect(normalizeBaseUrl('  https://x.dev//')).toBe('https://x.dev')
    expect(normalizeBaseUrl('   ')).toBe('')
  })
})
