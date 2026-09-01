import type { AgentDetail } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchAgentDetailMock = vi.fn<[string, unknown], Promise<AgentDetail | null>>()
vi.mock('../api', () => ({
  fetchAgentDetail: (agentId: string, filters: unknown) => fetchAgentDetailMock(agentId, filters),
}))

import AgentHealthPage from '../AgentHealthPage.vue'

const RouterLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' }

function health(overrides: Partial<AgentDetail['health']> = {}): AgentDetail['health'] {
  return {
    agentId: 'reviewer',
    runs: 10,
    success: 8,
    error: 2,
    cancelled: 0,
    truncated: 0,
    successRate: 0.8,
    failureClasses: {},
    avgDurationMs: 60_000,
    p95DurationMs: 120_000,
    tokensIn: 3_200_000,
    tokensOut: 50_000,
    cacheReadTokens: 2_000_000,
    cacheCreationTokens: 100_000,
    cacheHitRate: 0.38,
    iters: 570,
    toolCalls: 68,
    toolErrors: 3,
    stopReasons: {},
    lastRunAt: '2026-03-01T00:00:00.000Z',
    promptVersions: 2,
    systemPromptVersions: 1,
    costUsd: 8.4,
    models: { 'claude-sonnet-5': 10 },
    toolBreakdown: {
      fs_read: { calls: 50, errors: 0 },
      bash_run: { calls: 18, errors: 3 },
    },
    ...overrides,
  }
}

function detail(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agentId: 'reviewer',
    health: health(),
    byPromptVersion: [
      {
        promptHash: 'v2',
        runs: 5,
        success: 3,
        successRate: 0.6,
        firstSeen: '2026-02-20T00:00:00.000Z',
        lastSeen: '2026-03-01T00:00:00.000Z',
        iters: 300,
        tokensIn: 2_000_000,
        cacheHitRate: 0.3,
        costUsd: 5,
      },
      {
        promptHash: 'v1',
        runs: 5,
        success: 5,
        successRate: 1,
        firstSeen: '2026-02-01T00:00:00.000Z',
        lastSeen: '2026-02-19T00:00:00.000Z',
        iters: 270,
        tokensIn: 1_200_000,
        cacheHitRate: 0.5,
        costUsd: 3.4,
      },
    ],
    bySystemPromptVersion: [
      {
        systemPromptHash: 's1',
        runs: 10,
        success: 8,
        successRate: 0.8,
        firstSeen: '2026-02-01T00:00:00.000Z',
        lastSeen: '2026-03-01T00:00:00.000Z',
        iters: 570,
        tokensIn: 3_200_000,
        cacheHitRate: 0.38,
        costUsd: 8.4,
      },
    ],
    byDay: [{ day: '2026-03-01', runs: 2, success: 1 }],
    recentFailures: [],
    ...overrides,
  }
}

function mountPage(props: Record<string, unknown> = {}) {
  return mount(AgentHealthPage, {
    props: {
      agentId: 'reviewer',
      projectId: 'proj-1',
      editorPath: '/general/agentes/reviewer',
      ...props,
    },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}

describe('AgentHealthPage', () => {
  beforeEach(() => {
    fetchAgentDetailMock.mockReset()
    fetchAgentDetailMock.mockResolvedValue(detail())
  })

  it('pide el detalle del agente con la ventana y el proyecto', async () => {
    mountPage()
    await flushPromises()
    const [agentId, filters] = fetchAgentDetailMock.mock.calls[0]!
    expect(agentId).toBe('reviewer')
    expect((filters as { projectId: string }).projectId).toBe('proj-1')
  })

  it('muestra el resumen con costo por run y el link al editor', async () => {
    const wrapper = mountPage()
    await flushPromises()
    const tiles = wrapper.findAll('.tile').map((t) => t.text())
    expect(tiles.some((t) => t.includes('$8.40') && t.includes('$0.84 por run'))).toBe(true)
    expect(wrapper.find('.agent-page__editor').attributes('href')).toBe('/general/agentes/reviewer')
  })

  it('cruza los dos hashes: cambió el agente, no el system prompt', async () => {
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.text()).toContain('El agente cambió en la ventana; sus system prompts no')
    expect(wrapper.find('.delta').text()).toContain('-40 pts')
  })

  it('lee un cambio de system prompt como algo compartido', async () => {
    fetchAgentDetailMock.mockResolvedValue(
      detail({ health: health({ promptVersions: 1, systemPromptVersions: 2 }) }),
    )
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.text()).toContain('Cambió un system prompt en la ventana')
  })

  it('lista las tools por llamadas, con los errores al lado', async () => {
    const wrapper = mountPage()
    await flushPromises()
    const rows = wrapper.findAll('.tool-row')
    expect(rows[0]!.find('.tool-row__name').text()).toBe('fs_read')
    expect(rows[1]!.find('.tool-row__errors').text()).toBe('3 err')
    expect(rows[0]!.find('.tool-row__errors').text()).toBe('')
  })

  it('emite close al volver y drill desde un fallo', async () => {
    fetchAgentDetailMock.mockResolvedValue(
      detail({
        recentFailures: [
          {
            id: 'x',
            taskId: 't',
            taskTitle: 'Rompió',
            startedAt: '2026-03-01T10:00:00.000Z',
            outcome: 'error',
            failureClass: 'tool_failure',
            stopReason: null,
            errorExcerpt: 'boom',
          },
        ],
      }),
    )
    const wrapper = mountPage()
    await flushPromises()
    await wrapper.find('.class-chip').trigger('click')
    expect(wrapper.emitted('drill')![0]).toEqual([
      { agentId: 'reviewer', failureClass: 'tool_failure' },
    ])
    await wrapper.find('.btn--ghost').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('muestra el vacío cuando el agente no tiene runs en la ventana', async () => {
    fetchAgentDetailMock.mockResolvedValue(null)
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.find('.agent-page__empty').text()).toContain('Sin runs terminados')
  })
})
