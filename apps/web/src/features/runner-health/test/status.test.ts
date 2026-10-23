import type { Ingress, RunnerInfo, RunnerLogLine, RunnerResources } from '@ia-flow/shared'
import { describe, expect, it } from 'vitest'
import { recentProblems, rowsOf } from '../rows'
import {
  formatBytes,
  formatCpus,
  type HealthSnapshot,
  issuesOf,
  saturated,
  toLook,
  toLookTitle,
  verdictOf,
} from '../status'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const GB = 1_073_741_824

const info: RunnerInfo = {
  service: 'ia-flow-runner',
  version: '2.14.0',
  projects: [],
  github_login: { device_flow: true },
  assistant: true,
  assistant_agents: [{ id: 'assistant', label: 'Operación' }],
}

const ingress = (githubLast?: string): Ingress => ({
  retention_days: 14,
  sources: [
    {
      id: 'github',
      name: 'GitHub',
      kind: 'webhook',
      configured: true,
      count_24h: 12,
      count_kept: 40,
      ...(githubLast ? { last_at: githubLast } : {}),
    },
    {
      id: 'slack',
      name: 'Slack',
      kind: 'socket',
      configured: false,
      missing: 'SLACK_APP_TOKEN',
      count_24h: 0,
      count_kept: 0,
    },
  ],
})

const resources = (memRatio = 0.62, diskRatio = 0.41): RunnerResources => ({
  runner: {
    at: ago(0),
    memory: { used_bytes: memRatio * 2 * GB, total_bytes: 2 * GB, source: 'cgroup' },
    disk: { used_bytes: diskRatio * 20 * GB, total_bytes: 20 * GB, path: '/state' },
    load: { load1: 0.4, cpus: 1 },
    worktrees: 14,
  },
  hosts: [],
})

const line = (seq: number, level: RunnerLogLine['level'], message = `m${seq}`): RunnerLogLine => ({
  seq,
  time: ago(seq * MIN),
  level,
  scope: 'engine',
  message,
})

const healthy = (over: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
  checkedAt: NOW,
  alive: true,
  latencyMs: 120,
  info,
  webhooks: { secretConfigured: true, executions: { running: 2, waiting: 1, paused: 0 } },
  ingress: ingress(ago(4 * MIN)),
  resources: resources(),
  problems: [],
  ...over,
})

const occupancy = { running: 2, waiting: 1, free: 1, max: 3 }

describe('issuesOf / verdictOf', () => {
  it('todo en orden: nada para mirar y «Todo bien»', () => {
    const h = healthy()
    const issues = issuesOf(h, occupancy, NOW)
    expect(toLook(issues)).toEqual([])
    expect(verdictOf(h, issues, occupancy)).toEqual({ title: 'Todo bien', tone: 'ok' })
  })

  it('sin eventos de GitHub hace 2 h avisa con la explicación del mockup', () => {
    const h = healthy({ ingress: ingress(ago(120 * MIN)) })
    const issues = issuesOf(h, occupancy, NOW)
    expect(issues).toEqual([
      {
        tone: 'warn',
        text: 'No llegan eventos de GitHub hace 2 h. Si nadie movió el board, puede ser normal.',
      },
    ])
    expect(verdictOf(h, issues, occupancy).title).toBe('Responde, con avisos')
    expect(toLookTitle(1)).toBe('1 cosa para mirar')
    expect(toLookTitle(3)).toBe('3 cosas para mirar')
  })

  it('GitHub configurado y sin ningún evento todavía también avisa', () => {
    const issues = issuesOf(healthy({ ingress: ingress() }), occupancy, NOW)
    expect(issues.map((i) => i.text)).toEqual(['Todavía no llegó ningún evento de GitHub.'])
  })

  it('no responde: un solo problema y el veredicto «No responde»', () => {
    const h: HealthSnapshot = { checkedAt: NOW, alive: false, failure: 'Network Error' }
    const issues = issuesOf(h, occupancy, NOW)
    expect(issues).toEqual([{ tone: 'bad', text: 'No responde: Network Error' }])
    expect(verdictOf(h, issues, occupancy)).toEqual({ title: 'No responde', tone: 'bad' })
  })

  it('sin secreto de webhook es un problema y gana a «A tope»', () => {
    const h = healthy({ webhooks: { secretConfigured: false } })
    const full = { running: 3, waiting: 0, free: 0, max: 3 }
    const issues = issuesOf(h, full, NOW)
    expect(issues[0]?.tone).toBe('bad')
    expect(verdictOf(h, issues, full).title).toBe('Con problemas')
  })

  it('sin lugares libres está «A tope», y con cola avisa', () => {
    const h = healthy()
    const full = { running: 3, waiting: 2, free: 0, max: 3 }
    const issues = issuesOf(h, full, NOW)
    expect(issues.map((i) => i.text)).toContain('Sin lugar libre: 2 en cola.')
    expect(verdictOf(h, issues, full).title).toBe('A tope')
    expect(
      verdictOf(h, issuesOf(h, { ...full, waiting: 0 }, NOW), { ...full, waiting: 0 }).title,
    ).toBe('A tope')
  })

  it('memoria al 80 % avisa y al 90 % es problema (y a tope)', () => {
    const warn = healthy({ resources: resources(0.85) })
    expect(issuesOf(warn, occupancy, NOW)).toEqual([
      { tone: 'warn', text: 'El runner: memoria al 85 %' },
    ])
    const bad = healthy({ resources: resources(0.5, 0.95) })
    expect(issuesOf(bad, occupancy, NOW)).toEqual([
      { tone: 'bad', text: 'El runner: disco al 95 %' },
    ])
    expect(saturated(bad, occupancy)).toBe(true)
  })

  it('un host sin señales es problema; uno lleno con cola, aviso', () => {
    const r = resources()
    r.hosts = [
      {
        name: 'front',
        provider: 'remote:front',
        max_concurrent: 2,
        running: 2,
        last_seen: ago(10_000),
      },
      {
        name: 'e2e',
        provider: 'remote:e2e',
        max_concurrent: 1,
        running: 0,
        last_seen: ago(10 * MIN),
      },
    ]
    const texts = issuesOf(healthy({ resources: r }), occupancy, NOW).map((i) => i.text)
    expect(texts).toEqual([
      'e2e no da señales hace 10 min.',
      'front a tope (2/2) con trabajo en cola.',
    ])
    expect(saturated(healthy({ resources: r }), null)).toBe(true)
  })

  it('errores en el log reciente avisan; un runner viejo deja notas que no cuentan', () => {
    const h = healthy({
      problems: [line(1, 'warn'), line(2, 'error'), line(3, 'error')],
      resources: null,
    })
    const issues = issuesOf(h, occupancy, NOW)
    expect(toLook(issues).map((i) => i.text)).toEqual(['2 errores en el log reciente.'])
    expect(issues.filter((i) => i.tone === 'info')).toHaveLength(1)
    const old = healthy({ problems: null, resources: null })
    expect(toLook(issuesOf(old, occupancy, NOW))).toEqual([])
    expect(issuesOf(old, occupancy, NOW).map((i) => i.text)).toEqual([
      'Este runner no expone /api/resources: actualizalo para ver memoria, disco y worktrees.',
      'Este runner no expone /api/logs: actualizalo para ver sus errores.',
    ])
  })
})

describe('rowsOf', () => {
  it('las filas del mockup, en orden, con su detalle', () => {
    const rows = rowsOf(healthy(), occupancy, NOW)
    expect(rows.map((r) => [r.label, r.detail, r.tone])).toEqual([
      ['Responde', '120 ms · v2.14.0', 'ok'],
      ['Capacidad', '2 de 3 lugares ocupados · 1 en cola', 'ok'],
      ['Memoria', '62 % del contenedor · 1.2 GB de 2.0 GB', 'ok'],
      ['Disco', '41 % · 14 worktrees', 'ok'],
      ['Carga', '0.40 · 1 CPU', 'ok'],
      ['GitHub', 'último evento hace 4 min · 12 en 24 h', 'ok'],
      ['Slack', 'sin configurar (falta SLACK_APP_TOKEN)', 'off'],
      ['Asistente', 'disponible · Operación', 'ok'],
    ])
  })

  it('GitHub callado hace 2 h pregunta si se cortó el webhook', () => {
    const rows = rowsOf(healthy({ ingress: ingress(ago(120 * MIN)) }), occupancy, NOW)
    expect(rows.find((r) => r.id === 'source:github')).toMatchObject({
      detail: 'último evento hace 2 h — ¿se cortó el webhook?',
      tone: 'warn',
    })
  })

  it('lo que el runner no expone no se dibuja (R13)', () => {
    const rows = rowsOf(
      healthy({ info: null, webhooks: null, ingress: null, resources: null, latencyMs: 80 }),
      null,
      NOW,
    )
    expect(rows.map((r) => [r.label, r.detail])).toEqual([['Responde', '80 ms']])
  })

  it('sin la bandeja, la capacidad sale de /api/webhooks/status', () => {
    const rows = rowsOf(healthy(), null, NOW)
    expect(rows.find((r) => r.id === 'capacity')?.detail).toBe('2 corriendo · 1 en cola')
  })

  it('un host es una fila con sus lugares y recursos', () => {
    const r = resources()
    r.hosts = [
      {
        name: 'front',
        provider: 'remote:front',
        max_concurrent: 2,
        running: 1,
        last_seen: ago(0),
        resources: {
          at: ago(0),
          memory: { used_bytes: 0.85 * 8 * GB, total_bytes: 8 * GB, source: 'cgroup' },
          worktrees: 7,
        },
      },
    ]
    const host = rowsOf(healthy({ resources: r }), occupancy, NOW).find(
      (x) => x.id === 'host:front',
    )
    expect(host).toMatchObject({
      detail: '1/2 corriendo · memoria 85 % · 7 worktrees',
      tone: 'warn',
    })
  })

  it('caído, sin filas', () => {
    expect(rowsOf({ checkedAt: NOW, alive: false }, occupancy, NOW)).toEqual([])
  })
})

describe('formatos', () => {
  it('bytes y CPUs como el menú', () => {
    expect(formatBytes(512 * 1_048_576)).toBe('512 MB')
    expect(formatBytes(1.25 * GB)).toBe('1.3 GB')
    expect(formatBytes(40 * GB)).toBe('40 GB')
    expect(formatCpus(2)).toBe('2')
    expect(formatCpus(1.5)).toBe('1.5')
  })

  it('los últimos avisos, del más nuevo y con tope', () => {
    const h = healthy({ problems: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => line(n, 'warn')) })
    expect(recentProblems(h).map((l) => l.seq)).toEqual([8, 7, 6, 5, 4, 3])
    expect(recentProblems(healthy({ problems: null }))).toEqual([])
  })
})
