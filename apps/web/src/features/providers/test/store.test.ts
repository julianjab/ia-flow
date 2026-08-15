import type { ProvidersResponse } from '@/features/providers/api'
import type { AnthropicApiSettings, ProviderConfig } from '@ia-flow/shared'
import axios from 'axios'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useProvidersStore } from '../store'

const snap = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const anthropicApi: AnthropicApiSettings = {
  model: 'claude-sonnet-4-5',
  anthropicVersion: '2023-06-01',
  anthropicBeta: [],
  systemPrompt: [{ type: 'text', text: 'hello' }],
}

const baseConfig: ProviderConfig = {
  steps: {
    'refine-functional': 'anthropic-api',
    'refine-technical': 'anthropic-api',
    implement: 'anthropic-api',
  },
  anthropicApi,
}

const providers = [
  { id: 'anthropic-api', name: 'Claude API', description: 'a' },
  { id: 'claude-code', name: 'Claude Code', description: 'b' },
  { id: 'codex', name: 'Codex', description: 'c' },
]

const originalGet = axios.get
const originalPut = axios.put

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  axios.get = originalGet
  axios.put = originalPut
})

describe('providers store', () => {
  it('fetchConfig hidrata el store', async () => {
    const response: ProvidersResponse = { providers, config: baseConfig }
    const calls: string[] = []
    axios.get = (async (url: string) => {
      calls.push(url)
      return { data: response, status: 200, statusText: 'OK', headers: {}, config: {} }
    }) as any

    const store = useProvidersStore()
    await store.fetchConfig()

    expect(calls).toEqual(['/api/providers'])
    expect(store.providers).toHaveLength(3)
    expect(snap(store.providers)).toEqual(providers)
    expect(snap(store.config)).toEqual(baseConfig)
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('saveConfig envía el body completo y reemplaza state.config', async () => {
    const edited: ProviderConfig = {
      steps: { ...baseConfig.steps, implement: 'claude-code' },
      anthropicApi: { ...anthropicApi, stream: true },
    }
    const calls: { url: string; body: unknown }[] = []
    axios.put = (async (url: string, body: unknown) => {
      calls.push({ url, body })
      return { data: edited, status: 200, statusText: 'OK', headers: {}, config: {} }
    }) as any

    const store = useProvidersStore()
    await store.saveConfig({ steps: edited.steps, anthropicApi: edited.anthropicApi })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/providers/config')
    expect(calls[0].body).toEqual({ steps: edited.steps, anthropicApi: edited.anthropicApi })
    expect(snap(store.config)).toEqual(edited)
    expect(store.error).toBeNull()
    expect(store.saving).toBe(false)
  })

  it('saveConfig propaga error del server y no resetea config', async () => {
    const store = useProvidersStore()
    store.config = baseConfig

    axios.put = (async () => {
      const err = new axios.AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST')
      err.response = {
        data: { error: 'invalid model' },
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config: {} as any,
      }
      throw err
    }) as any

    await store.saveConfig({ steps: baseConfig.steps, anthropicApi: baseConfig.anthropicApi })

    expect(store.error).toBe('invalid model')
    expect(snap(store.config)).toEqual(baseConfig)
    expect(store.saving).toBe(false)
  })

  it('exposes stepsList getter with the 3 known steps', () => {
    const store = useProvidersStore()
    expect(store.stepsList).toEqual(['refine-functional', 'refine-technical', 'implement'])
  })
})
