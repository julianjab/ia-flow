import type { ProjectConfig } from '@ia-flow/shared'
import axios from 'axios'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useProjectConfigStore } from '../store'

const snap = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const baseConfig: ProjectConfig = {
  project: { name: 'ia-flow', language: 'typescript', defaultOwner: 'la-haus' },
  agents: [],
  statuses: [],
}

const originalGet = axios.get

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  axios.get = originalGet
})

describe('project-config store', () => {
  describe('fetch', () => {
    it('hidrata config y raw, limpia loading', async () => {
      const calls: string[] = []
      axios.get = (async (url: string) => {
        calls.push(url)
        return { data: { config: baseConfig, raw: 'yaml: content' } }
      }) as any

      const store = useProjectConfigStore()
      expect(store.loading).toBe(false)

      await store.fetch()

      expect(calls).toEqual(['/api/project-config'])
      expect(snap(store.config)).toEqual(baseConfig)
      expect(store.raw).toBe('yaml: content')
      expect(store.loading).toBe(false)
    })

    it('limpia loading aunque fetch falle', async () => {
      axios.get = (async () => {
        throw new Error('network error')
      }) as any

      const store = useProjectConfigStore()
      await expect(store.fetch()).rejects.toThrow('network error')
      expect(store.loading).toBe(false)
    })

    it('acepta config null en la respuesta', async () => {
      axios.get = (async () => ({ data: { config: null, raw: '' } })) as any

      const store = useProjectConfigStore()
      await store.fetch()
      expect(store.config).toBeNull()
      expect(store.raw).toBe('')
    })
  })
})
