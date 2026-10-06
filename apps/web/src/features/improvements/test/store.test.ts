import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGithubSessionStore } from '@/stores/githubSession'
import { useImprovementsSignalStore } from '@/stores/improvementsSignal'
import { proposal } from './fixtures'

const getImprovements = vi.fn()
const openImprovement = vi.fn()
const dismissImprovement = vi.fn()
vi.mock('../api', () => ({
  getImprovements: (...a: unknown[]) => getImprovements(...a),
  openImprovement: (...a: unknown[]) => openImprovement(...a),
  dismissImprovement: (...a: unknown[]) => dismissImprovement(...a),
}))

import { useImprovementsStore } from '../store'

function setup(login = true) {
  setActivePinia(createPinia())
  if (login) useGithubSessionStore().github = { token: 'gho_1', login: 'ada' }
  return useImprovementsStore()
}

describe('store de mejoras', () => {
  beforeEach(() => vi.clearAllMocks())

  it('load llena las pendientes; un runner sin mejoras (null) las deja vacías', async () => {
    const store = setup()
    getImprovements.mockResolvedValueOnce({ items: [proposal()] })
    await store.load()
    expect(store.count).toBe(1)
    getImprovements.mockResolvedValueOnce(null)
    await store.load()
    expect(store.count).toBe(0)
  })

  it('una falla de red al cargar no rompe ni borra lo que había', async () => {
    const store = setup()
    getImprovements.mockResolvedValueOnce({ items: [proposal()] })
    await store.load()
    getImprovements.mockRejectedValueOnce(new Error('caído'))
    await store.load()
    expect(store.count).toBe(1)
  })

  it('open con éxito saca la pendiente pero deja la abierta con su link', async () => {
    const store = setup()
    const p = proposal()
    getImprovements.mockResolvedValueOnce({ items: [p] })
    await store.load()
    const opened = {
      ...p,
      status: 'opened' as const,
      issue_url: 'https://github.com/acme/api/issues/1',
    }
    openImprovement.mockResolvedValueOnce({ ok: true, message: 'acme/api#1', proposal: opened })
    await store.open(p)
    expect(openImprovement).toHaveBeenCalledWith('imp-1', 'gho_1')
    expect(store.count).toBe(0)
    expect(store.items).toHaveLength(1)
    expect(store.states['imp-1']).toMatchObject({ status: 'done', url: opened.issue_url })
  })

  it('un rechazo deja el mensaje como error y recarga', async () => {
    const store = setup()
    const p = proposal()
    getImprovements.mockResolvedValue({ items: [p] })
    await store.load()
    openImprovement.mockResolvedValueOnce({ ok: false, message: 'sin permisos' })
    await store.open(p)
    expect(store.states['imp-1']).toEqual({ status: 'error', message: 'sin permisos' })
    expect(getImprovements).toHaveBeenCalledTimes(2)
  })

  it('dismiss la saca de la lista', async () => {
    const store = setup()
    const p = proposal()
    getImprovements.mockResolvedValueOnce({ items: [p] })
    await store.load()
    dismissImprovement.mockResolvedValueOnce({ ok: true, message: 'descartada' })
    await store.dismiss(p)
    expect(store.items).toHaveLength(0)
  })

  it('sin login no sale ninguna request: pide el login', async () => {
    const store = setup(false)
    await store.open(proposal())
    expect(openImprovement).not.toHaveBeenCalled()
    expect(useGithubSessionStore().loginOpen).toBe(true)
  })

  it('la señal del stream recarga', async () => {
    const store = setup()
    getImprovements.mockResolvedValue({ items: [] })
    useImprovementsSignalStore().bump()
    await vi.waitFor(() => expect(getImprovements).toHaveBeenCalled())
    expect(store.count).toBe(0)
  })
})
