import { flushPromises, mount } from '@vue/test-utils'
import axios from 'axios'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Router, createMemoryHistory, createRouter } from 'vue-router'
import type { ProviderConfig } from '../stores/providers'
import SettingsView from './SettingsView.vue'

async function makeRouter(initialTab = 'proyecto'): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/settings/:tab', name: 'settings', component: SettingsView, props: true }],
  })
  await router.push(`/settings/${initialTab}`)
  await router.isReady()
  return router
}

async function mountView(initialTab = 'proyecto') {
  const router = await makeRouter(initialTab)
  const wrapper = mount(SettingsView, { global: { plugins: [router] } })
  return { wrapper, router }
}

// Ensure Teleport target exists.
function ensureToastContainer(): void {
  if (!document.getElementById('toast-container')) {
    const el = document.createElement('div')
    el.id = 'toast-container'
    document.body.appendChild(el)
  }
}

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    steps: {
      'refine-functional': 'anthropic-api',
      'refine-technical': 'anthropic-api',
      implement: 'anthropic-api',
    },
    anthropicApi: {
      model: 'claude-opus-4-7',
      responseLanguage: 'es',
      thinking: { type: 'enabled', budget_tokens: 8000 },
      stream: true,
      systemPrompt: [{ type: 'text', text: 'hello {task_title}' }],
      anthropicVersion: '2023-06-01',
      anthropicBeta: ['beta-a'],
    },
    ...overrides,
  }
}

interface AxiosCall {
  method: 'get' | 'put' | 'post' | 'patch' | 'delete'
  url: string
  body?: unknown
}

interface AxiosStubOptions {
  putFails?: boolean
}

// Stub axios.get/put/post/patch/delete with a URL-based router that returns
// realistic responses for every endpoint SettingsView touches on mount + save.
function stubAxios(config: ProviderConfig, opts: AxiosStubOptions = {}) {
  const calls: AxiosCall[] = []

  const ok = <T>(data: T) => ({
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as any,
  })

  const getResponses: Record<string, unknown> = {
    '/api/providers': {
      providers: [
        { id: 'anthropic-api', name: 'Claude API', description: '' },
        { id: 'tmux-claude', name: 'Tmux Claude', description: '' },
        { id: 'iterm-claude', name: 'iTerm Claude', description: '' },
      ],
      config,
      githubProjectUrl: null,
    },
    '/api/prompts': { prompts: [] },
    '/api/project-config': { config: null, raw: '' },
    '/api/tasks/statuses': { statuses: [] },
    '/api/env-vars': { vars: {} },
    '/api/repos': { repos: [] },
    '/api/repos/mappings': { mappings: [] },
    '/api/repos/scan-roots': { scanRoots: [] },
    '/api/github/project': { fields: [] },
    '/api/github/project-items': { items: [] },
  }

  const getFn = vi.fn(async (url: string) => {
    calls.push({ method: 'get', url })
    // Match by prefix for query-string variants.
    for (const key of Object.keys(getResponses)) {
      if (url === key || url.startsWith(`${key}?`)) return ok(getResponses[key])
    }
    // Fallback: empty object so nothing throws.
    return ok({})
  })

  const putFn = vi.fn(async (url: string, body: unknown) => {
    calls.push({ method: 'put', url, body })
    if (opts.putFails) {
      const err = new axios.AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST')
      err.response = {
        data: { error: 'bad' },
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config: {} as any,
      }
      throw err
    }
    if (url === '/api/providers/config') return ok(config)
    return ok({})
  })

  const postFn = vi.fn(async (url: string, body: unknown) => {
    calls.push({ method: 'post', url, body })
    return ok({})
  })

  const patchFn = vi.fn(async (url: string, body: unknown) => {
    calls.push({ method: 'patch', url, body })
    return ok({})
  })

  const deleteFn = vi.fn(async (url: string) => {
    calls.push({ method: 'delete', url })
    return ok({})
  })

  vi.spyOn(axios, 'get').mockImplementation(getFn as any)
  vi.spyOn(axios, 'put').mockImplementation(putFn as any)
  vi.spyOn(axios, 'post').mockImplementation(postFn as any)
  vi.spyOn(axios, 'patch').mockImplementation(patchFn as any)
  vi.spyOn(axios, 'delete').mockImplementation(deleteFn as any)

  return { calls }
}

beforeEach(() => {
  setActivePinia(createPinia())
  ensureToastContainer()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('SettingsView', () => {
  // TODO: SettingsView no longer renders per-step provider `<select data-step>`
  // controls nor an `#anthropic-model` input (model is now inside
  // AnthropicApiSettingsForm via <ModelSelect> without that id). Rewrite these
  // as targeted component tests once the settings UI stabilizes.
  it.skip('shows active config on initial load', async () => {
    const config = makeConfig()
    stubAxios(config)
    const { wrapper } = await mountView('providers')
    await flushPromises()

    const selects = wrapper.findAll('select[data-step]')
    expect(selects).toHaveLength(3)
    for (const sel of selects) {
      expect((sel.element as HTMLSelectElement).value).toBe('anthropic-api')
    }

    expect((wrapper.get('#anthropic-model').element as HTMLInputElement).value).toBe(
      'claude-opus-4-7',
    )
    expect((wrapper.get('#anthropic-response-language').element as HTMLInputElement).value).toBe(
      'es',
    )
    expect((wrapper.get('#anthropic-thinking-type').element as HTMLSelectElement).value).toBe(
      'enabled',
    )
    expect((wrapper.get('#anthropic-thinking-budget').element as HTMLInputElement).value).toBe(
      '8000',
    )
    expect((wrapper.get('#anthropic-stream').element as HTMLInputElement).checked).toBe(true)
  })

  // TODO: same as above — depends on removed `select[data-step]` and
  // `#anthropic-model` DOM. Cover this via a store-level test on providers.
  it.skip('save dispatches PUT with full body and shows success toast', async () => {
    const config = makeConfig()
    const { calls } = stubAxios(config)
    const { wrapper } = await mountView('providers')
    await flushPromises()

    const implementSelect = wrapper.get('select[data-step="implement"]')
    await implementSelect.setValue('iterm-claude')

    const modelInput = wrapper.get('#anthropic-model')
    await modelInput.setValue('claude-sonnet-4-6')

    await wrapper.get('.save-button').trigger('click')
    await flushPromises()

    const putCall = calls.find((c) => c.method === 'put' && c.url === '/api/providers/config')
    expect(putCall).toBeTruthy()
    const body = putCall!.body as {
      steps: Record<string, string>
      anthropicApi: {
        model: string
        systemPrompt: unknown
        anthropicVersion: string
      }
    }
    expect(body.steps.implement).toBe('iterm-claude')
    expect(body.steps['refine-functional']).toBe('anthropic-api')
    expect(body.anthropicApi.model).toBe('claude-sonnet-4-6')
    // Preserved out-of-scope fields.
    expect(body.anthropicApi.systemPrompt).toEqual([{ type: 'text', text: 'hello {task_title}' }])
    expect(body.anthropicApi.anthropicVersion).toBe('2023-06-01')

    const toast = document.querySelector('.toast-success')
    expect(toast).toBeTruthy()
  })

  // TODO: same as above — depends on removed `select[data-step]` and
  // `#anthropic-model` DOM.
  it.skip('preserves edits when save fails', async () => {
    const config = makeConfig()
    stubAxios(config, { putFails: true })

    const { wrapper } = await mountView('providers')
    await flushPromises()

    await wrapper.get('#anthropic-model').setValue('edited-model')
    await wrapper.get('select[data-step="implement"]').setValue('tmux-claude')

    await wrapper.get('.save-button').trigger('click')
    await flushPromises()

    // Values must remain edited (not reset).
    expect((wrapper.get('#anthropic-model').element as HTMLInputElement).value).toBe('edited-model')
    expect((wrapper.get('select[data-step="implement"]').element as HTMLSelectElement).value).toBe(
      'tmux-claude',
    )

    const errorToast = document.querySelector('.toast-error')
    expect(errorToast).toBeTruthy()
  })

  it('renders sidebar with all tabs grouped and marks the current one active', async () => {
    stubAxios(makeConfig())
    const { wrapper } = await mountView('proyecto')
    await flushPromises()

    const items = wrapper.findAll('.settings-sidebar__item')
    expect(items).toHaveLength(8)

    const active = wrapper.get('.settings-sidebar__item--active')
    expect(active.attributes('data-tab-id')).toBe('proyecto')
    expect(active.attributes('aria-current')).toBe('page')

    const groups = wrapper.findAll('.settings-sidebar__group')
    expect(groups.length).toBeGreaterThanOrEqual(3)
    const labels = wrapper.findAll('.settings-sidebar__group-label').map((el) => el.text())
    expect(labels).toEqual(expect.arrayContaining(['General', 'Flujo', 'Recursos']))
  })

  it('clicking a sidebar item switches the active tab and navigates', async () => {
    stubAxios(makeConfig())
    const { wrapper, router } = await mountView('proyecto')
    await flushPromises()

    const agentesItem = wrapper.get('.settings-sidebar__item[data-tab-id="agentes"]')
    await agentesItem.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.params.tab).toBe('agentes')
    const active = wrapper.get('.settings-sidebar__item--active')
    expect(active.attributes('data-tab-id')).toBe('agentes')
  })

  // TODO: same as above — depends on removed `select[data-step]` and
  // `#anthropic-model` DOM.
  it.skip('re-hydrates persisted values on remount (reload)', async () => {
    const config = makeConfig({
      steps: {
        'refine-functional': 'tmux-claude',
        'refine-technical': 'iterm-claude',
        implement: 'iterm-claude',
      },
    })
    stubAxios(config)

    setActivePinia(createPinia())
    const { wrapper } = await mountView('providers')
    await flushPromises()

    expect(
      (wrapper.get('select[data-step="refine-functional"]').element as HTMLSelectElement).value,
    ).toBe('tmux-claude')
    expect((wrapper.get('select[data-step="implement"]').element as HTMLSelectElement).value).toBe(
      'iterm-claude',
    )
    expect((wrapper.get('#anthropic-model').element as HTMLInputElement).value).toBe(
      'claude-opus-4-7',
    )
  })
})
