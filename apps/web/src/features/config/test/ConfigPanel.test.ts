import type { ConfigSummary } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getConfig = vi.fn()
vi.mock('../api', () => ({ getConfig: () => getConfig() }))

import ConfigPanel from '../ConfigPanel.vue'

const pipeline = (over: Partial<ConfigSummary['pipelines'][number]>) => ({
  id: 'review',
  source_id: 'core',
  on: ['issue.status_changed'],
  when: ['to eq "Review"', 'task.pr.number exists'],
  exclusive: true,
  position: 10,
  agents: ['reviewer'],
  actions: [],
  ...over,
})

const config: ConfigSummary = {
  projects: [
    { id: 'core', board: { owner: 'acme', number: 1 } },
    { id: 'web', board: { owner: 'acme', number: 2 } },
  ],
  pipelines: [
    pipeline({}),
    pipeline({ id: 'build', position: 5, when: [], exclusive: false, agents: ['implementer'] }),
    pipeline({
      id: 'intake',
      source_id: 'runner',
      on: ['github.projects_v2_item'],
      agents: [],
      actions: ['resolve_task'],
    }),
    pipeline({ id: 'web-review', source_id: 'web' }),
  ],
  agents: [
    {
      id: 'reviewer',
      providers: ['claude-tmux', 'anthropic-api'],
      routes: { approved: '(nada)', changes: 'implementer' },
    },
  ],
  providers: [{ id: 'claude-tmux', type: 'claude-cli', mode: 'tmux', max_concurrent: 2 }],
  mcp: [{ id: 'github-mcp', host: 'api.githubcopilot.com' }],
}

describe('ConfigPanel', () => {
  beforeEach(() => getConfig.mockReset().mockResolvedValue(config))

  it('agrupa las pipelines por fuente, la global primero, cada una en su orden', async () => {
    const w = mount(ConfigPanel)
    await flushPromises()
    expect(w.findAll('.cp__hd').map((h) => h.text().split(/\s/)[0])).toEqual([
      'Global',
      'core',
      'web',
    ])
    const core = w.findAll('.cp')[1]
    expect(core?.findAll('.cp__id').map((i) => i.text())).toEqual(['build', 'review'])
  })

  it('una pipeline plegada dice qué escucha y qué corre; abierta, sus condiciones una por renglón', async () => {
    const w = mount(ConfigPanel)
    await flushPromises()
    const review = w.findAll('.cp__item').find((d) => d.find('.cp__id').text() === 'review')
    expect(review?.find('summary').text()).toContain('issue.status_changed')
    expect(review?.find('summary').text()).toContain('reviewer')
    expect(review?.findAll('.cp__when li').map((l) => l.text())).toEqual([
      'to eq "Review"',
      'task.pr.number exists',
    ])
  })

  it('filtrar por proyecto deja la global y ese proyecto', async () => {
    const w = mount(ConfigPanel)
    await flushPromises()
    const web = w.findAll('.cfg__chip').find((c) => c.text() === 'web')
    await web?.trigger('click')
    expect(w.findAll('.cp__hd').map((h) => h.text().split(/\s/)[0])).toEqual(['Global', 'web'])
  })

  it('muestra agentes con sus salidas, providers y MCP', async () => {
    const w = mount(ConfigPanel)
    await flushPromises()
    const text = w.text()
    expect(text).toContain('claude-tmux → anthropic-api')
    expect(text).toContain('changes → implementer')
    expect(text).toContain('claude-cli · tmux')
    expect(text).toContain('hasta 2 a la vez')
    expect(text).toContain('api.githubcopilot.com')
  })

  it('un error se muestra con Reintentar', async () => {
    getConfig.mockRejectedValue(new Error('runner caído'))
    const w = mount(ConfigPanel)
    await flushPromises()
    expect(w.text()).toContain('✕ runner caído')
    getConfig.mockResolvedValue(config)
    await w.find('.cfg__err .btn').trigger('click')
    await flushPromises()
    expect(w.findAll('.cp').length).toBe(3)
  })
})
