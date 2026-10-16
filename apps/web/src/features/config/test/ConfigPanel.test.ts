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
      models: { 'claude-tmux': 'claude-sonnet-5-5', 'anthropic-api': 'claude-opus-5-5' },
      routes: { approved: '(nada)', changes: 'implementer' },
      mcp_servers: [
        { id: 'github', mounted: true },
        { id: 'figma', mounted: false },
      ],
      actions: ['read_file', 'add_comment'],
      prompt: {
        system: 'Sos el reviewer.',
        system_chars: 4_200,
        task: 'Revisá {{task.ref}}',
        task_chars: 19,
      },
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

  it('cada agente dice su modelo, sus MCP (y cuál no quedó montado), sus tools y su prompt plegado', async () => {
    const w = mount(ConfigPanel)
    await flushPromises()
    expect(w.get('[data-test="models"]').text()).toBe('claude-sonnet-5-5 · claude-opus-5-5')
    expect(w.text()).toContain('1 MCP sin montar')
    expect(w.get('[data-test="mcp-figma"]').text()).toBe('figma (sin montar)')
    expect(w.get('[data-test="mcp-github"]').text()).toBe('github')
    expect(w.text()).toContain('read_file · add_comment')
    const prompt = w.get('[data-test="prompt"]')
    expect(prompt.attributes('open')).toBeUndefined()
    expect(prompt.find('summary').text()).toContain('system 4.2k car.')
    // El runner mandó un recorte: se dice dónde está el completo.
    expect(prompt.text()).toContain('Recortado')
    expect(prompt.text()).toContain('Revisá {{task.ref}}')
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
