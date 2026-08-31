import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyAgentHostEnv, loadAgentHostConfig, resolveAgentHostConfigPath } from './config.js'

const ENV_KEYS = [
  'AGENT_HOST_CONFIG',
  'PORT',
  'LOG_LEVEL',
  'IA_FLOW_INSTANCE_ID',
  'AGENT_HOST_PROVIDER',
  'IA_FLOW_PROVIDER_NAME',
  'IA_FLOW_AGENT_HOST_PUBLIC_URL',
  'AGENT_HOST_MAX_CONCURRENT_RUNS',
  'IA_FLOW_REGISTER_SERVER_URLS',
  'IA_FLOW_REGISTER_RETRIES',
  'AGENT_HOST_REPOS_BASE',
  'OTEL_SDK_DISABLED',
] as const

const originalEnv: Record<string, string | undefined> = {}
let dir: string

beforeEach(() => {
  for (const k of ENV_KEYS) {
    originalEnv[k] = Bun.env[k]
    delete Bun.env[k]
  }
  dir = mkdtempSync(join(tmpdir(), 'agent-host-config-'))
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete Bun.env[k]
    else Bun.env[k] = originalEnv[k]
  }
  rmSync(dir, { recursive: true, force: true })
})

function write(yaml: string): string {
  const path = join(dir, 'agent-host.yaml')
  writeFileSync(path, yaml)
  return path
}

describe('loadAgentHostConfig', () => {
  it('parsea el archivo completo', () => {
    const path = write(`
settings:
  port: 3002
  logLevel: debug
  provider: anthropic-api
  providerName: frontend
  maxConcurrentRuns: 2
register:
  servers:
    - http://runner:3001
workspace:
  reposBase: /state/repos
admission:
  rules:
    - field: repo
      op: equals
      value: lh-seller-v2-frontend
`)

    const cfg = loadAgentHostConfig(path)

    expect(cfg?.settings?.providerName).toBe('frontend')
    expect(cfg?.register?.servers).toEqual(['http://runner:3001'])
    expect(cfg?.admission?.rules).toEqual([
      { field: 'repo', op: 'equals', value: 'lh-seller-v2-frontend' },
    ])
  })

  it('un path pedido a mano que no existe TIRA', () => {
    // Arrancar sin la config que alguien pidió deja al proceso sano en el
    // health check y admitiendo trabajo que no le toca.
    expect(() => loadAgentHostConfig(join(dir, 'no-existe.yaml'))).toThrow(
      /No se pudo leer el agent-host.yaml/,
    )
  })

  it('el path por convención ausente devuelve null — no rompe a quien usa sólo env vars', () => {
    expect(loadAgentHostConfig(join(dir, 'no-existe.yaml'), { explicit: false })).toBeNull()
  })

  it('un campo desconocido TIRA (schema strict)', () => {
    // Un typo en una regla de admisión, tolerado, se cobra tres días después
    // como "este agent-host tomó una tarea que no era suya".
    const path = write('settings:\n  provierName: frontend\n')
    expect(() => loadAgentHostConfig(path)).toThrow(/AgentHostConfigSchema/)
  })

  it('una regla de admisión con un `op` inventado TIRA', () => {
    const path = write('admission:\n  rules:\n    - { field: repo, op: contains, value: x }\n')
    expect(() => loadAgentHostConfig(path)).toThrow(/AgentHostConfigSchema/)
  })
})

describe('resolveAgentHostConfigPath', () => {
  it('argv gana sobre AGENT_HOST_CONFIG', () => {
    Bun.env.AGENT_HOST_CONFIG = '/del/env.yaml'
    expect(resolveAgentHostConfigPath(['bun', 'index.ts', '/de/argv.yaml'])).toEqual({
      path: '/de/argv.yaml',
      explicit: true,
    })
  })

  it('sin argv ni env, el path de la imagen — y no es explícito', () => {
    // `explicit: false` es lo que hace que su ausencia no rompa el arranque.
    expect(resolveAgentHostConfigPath(['bun', 'index.ts'])).toEqual({
      path: '/app/config/agent-host.yaml',
      explicit: false,
    })
  })
})

describe('applyAgentHostEnv', () => {
  it('vuelca settings, register y workspace al entorno', () => {
    const report = applyAgentHostEnv({
      settings: { port: 3002, logLevel: 'debug', providerName: 'frontend', otelDisabled: true },
      register: { servers: ['http://a:3001', 'http://b:3001'], retries: 3 },
      workspace: { reposBase: '/state/repos' },
    })

    expect(Bun.env.PORT).toBe('3002')
    expect(Bun.env.LOG_LEVEL).toBe('debug')
    expect(Bun.env.IA_FLOW_PROVIDER_NAME).toBe('frontend')
    expect(Bun.env.OTEL_SDK_DISABLED).toBe('true')
    // La lista se aplana con comas: es el formato que registerSelf ya parsea.
    expect(Bun.env.IA_FLOW_REGISTER_SERVER_URLS).toBe('http://a:3001,http://b:3001')
    expect(Bun.env.IA_FLOW_REGISTER_RETRIES).toBe('3')
    expect(Bun.env.AGENT_HOST_REPOS_BASE).toBe('/state/repos')
    expect(report.overriddenByEnv).toEqual([])
  })

  it('el env real gana, y lo pisado se reporta', () => {
    // Un `-e` puntual es cómo se overridea el YAML para debuggear sin editarlo.
    // Que además se reporte es lo que contesta "¿por qué no aplica el YAML?".
    Bun.env.LOG_LEVEL = 'trace'

    const report = applyAgentHostEnv({ settings: { logLevel: 'info', port: 3002 } })

    expect(Bun.env.LOG_LEVEL).toBe('trace')
    expect(report.overriddenByEnv).toEqual(['LOG_LEVEL'])
    expect(report.applied).toContain('PORT')
  })

  it('admission.rules no toca el entorno', () => {
    applyAgentHostEnv({ admission: { rules: [{ field: 'repo', op: 'equals', value: 'x' }] } })

    for (const k of ENV_KEYS) expect(Bun.env[k]).toBeUndefined()
  })
})
