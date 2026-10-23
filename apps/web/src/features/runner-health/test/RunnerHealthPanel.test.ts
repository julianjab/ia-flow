import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { HealthSnapshot } from '../status'

const checkHealth = vi.fn<() => Promise<HealthSnapshot>>()
vi.mock('../api', () => ({ checkHealth: () => checkHealth() }))

import RunnerHealthPanel from '../RunnerHealthPanel.vue'

const Blank = { template: '<p />' }
const GB = 1_073_741_824

function snapshot(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    checkedAt: Date.now(),
    alive: true,
    latencyMs: 120,
    info: {
      service: 'ia-flow-runner',
      version: '2.14.0',
      projects: [],
      github_login: { device_flow: true },
      assistant: true,
      assistant_agents: [],
    },
    webhooks: { secretConfigured: true },
    ingress: {
      retention_days: 14,
      sources: [
        {
          id: 'github',
          name: 'GitHub',
          kind: 'webhook',
          configured: true,
          count_24h: 3,
          count_kept: 3,
          last_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        },
      ],
    },
    resources: {
      runner: {
        at: new Date().toISOString(),
        memory: { used_bytes: GB, total_bytes: 2 * GB, source: 'cgroup' },
        disk: { used_bytes: GB, total_bytes: 4 * GB, path: '/state' },
        worktrees: 2,
      },
      hosts: [],
    },
    problems: [
      {
        seq: 1,
        time: '2026-10-20T11:58:00Z',
        level: 'warn',
        scope: 'github',
        message: 'webhook ignorado',
      },
      {
        seq: 2,
        time: '2026-10-20T12:04:00Z',
        level: 'error',
        scope: 'provider',
        message: 'provider timeout',
      },
    ],
    ...over,
  }
}

async function render(occupancy = { running: 2, waiting: 1, free: 1, max: 3 }) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/estado/logs', name: 'logs', component: Blank },
      { path: '/servers', component: Blank },
    ],
  })
  await router.push('/')
  const w = mount(RunnerHealthPanel, {
    props: { host: 'ia-flow.example.com', occupancy },
    global: { plugins: [router] },
  })
  await flushPromises()
  return { w, router }
}

let mounted: { unmount: () => void } | null = null
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  checkHealth.mockReset()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
})

describe('RunnerHealthPanel', () => {
  it('mientras revisa, el esqueleto', async () => {
    checkHealth.mockReturnValue(new Promise(() => {}))
    const { w } = await render()
    mounted = w
    expect(w.find('[aria-busy="true"]').exists()).toBe(true)
    expect(w.find('[data-test="summary"]').exists()).toBe(false)
  })

  it('primero lo que está mal; después una fila por cosa y los últimos avisos', async () => {
    checkHealth.mockResolvedValue(snapshot())
    const { w } = await render()
    mounted = w
    const summary = w.get('[data-test="summary"]')
    expect(summary.find('h2').text()).toBe('2 cosas para mirar')
    expect(summary.text()).toContain('No llegan eventos de GitHub hace 3 h.')
    expect(summary.text()).toContain('1 error en el log reciente.')
    expect(w.get('[data-test="verdict"]').text()).toBe('Responde, con avisos · v2.14.0 · 120 ms')
    expect(w.findAll('.rh__label').map((l) => l.text())).toEqual([
      'Responde',
      'Capacidad',
      'Memoria',
      'Disco',
      'GitHub',
      'Asistente',
    ])
    expect(w.get('[data-test="row-capacity"]').text()).toContain(
      '2 de 3 lugares ocupados · 1 en cola',
    )
    expect(w.get('[data-test="row-disk"]').text()).toContain('25 % · 2 worktrees')
    // Del más nuevo.
    expect(w.findAll('[data-test="problems"] .ll__msg').map((m) => m.text())).toEqual([
      'provider timeout',
      'webhook ignorado',
    ])
    expect(w.get('[data-test="to-logs"]').attributes('href')).toBe('/estado/logs')
  })

  it('sin nada que mirar: «Todo bien»', async () => {
    checkHealth.mockResolvedValue(snapshot({ problems: [], ingress: null }))
    const { w } = await render()
    mounted = w
    expect(w.get('[data-test="summary"] h2').text()).toBe('Todo bien')
    expect(w.get('[data-test="summary"]').classes()).toContain('hs--ok')
    expect(w.find('[data-test="problems"]').exists()).toBe(false)
  })

  it('sin lugares libres: «A tope»', async () => {
    checkHealth.mockResolvedValue(snapshot({ problems: [], ingress: null }))
    const { w } = await render({ running: 3, waiting: 0, free: 0, max: 3 })
    mounted = w
    expect(w.get('[data-test="summary"] h2').text()).toBe('A tope')
  })

  it('un runner viejo sin /api/resources ni /api/logs: sin esas filas, con la nota', async () => {
    checkHealth.mockResolvedValue(snapshot({ resources: null, problems: null, ingress: null }))
    const { w } = await render()
    mounted = w
    expect(w.find('[data-test="row-memory"]').exists()).toBe(false)
    expect(w.find('[data-test="row-disk"]').exists()).toBe(false)
    expect(w.get('[data-test="summary"]').text()).toContain('no expone /api/resources')
  })

  it('se relee cada 6 s y con «Revisar de nuevo»', async () => {
    checkHealth.mockResolvedValue(snapshot())
    const { w } = await render()
    mounted = w
    expect(checkHealth).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(6000)
    await flushPromises()
    expect(checkHealth).toHaveBeenCalledTimes(2)
    await w.get('[data-test="recheck"]').trigger('click')
    await flushPromises()
    expect(checkHealth).toHaveBeenCalledTimes(3)
  })

  it('si deja de responder: el aviso con Reintentar y lo último que se vio, atenuado', async () => {
    checkHealth.mockResolvedValueOnce(snapshot())
    const { w } = await render()
    mounted = w
    checkHealth.mockResolvedValue({ checkedAt: Date.now(), alive: false, failure: 'Network Error' })
    vi.advanceTimersByTime(6000)
    await flushPromises()
    const down = w.get('[data-test="down"]')
    expect(down.attributes('role')).toBe('alert')
    expect(down.text()).toContain('ia-flow.example.com no responde: Network Error')
    expect(down.text()).toContain('Lo último que se vio queda abajo, atenuado.')
    expect(w.find('[data-test="summary"]').exists()).toBe(false)
    expect(w.get('.rh__body').classes()).toContain('rh__body--stale')
    expect(w.find('[data-test="row-alive"]').exists()).toBe(true)
  })
})
