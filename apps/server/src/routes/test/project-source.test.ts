import { describe, expect, mock, test } from 'bun:test'
import type { Blocker, SourceItem } from '@ia-flow/issue-sources'

// Mismo motivo que executions.test.ts: el router importa el container, que
// abre una conexión SQLite real como efecto de import.
const item = (id: string): SourceItem => ({ id, title: `Issue ${id}`, status: 'build' })

let getBlockersCalls: string[] = []
let getItemsCalls = 0
let failFor: string | null = null
let supportsBlockers = true

let lookedUp: string[] = []
let lookupResolves = true

const source = {
  kind: 'github-issues',
  getItems: async () => {
    getItemsCalls++
    return [item('a'), item('b'), item('c')]
  },
  getItemById: async (id: string) => {
    lookedUp.push(id)
    return lookupResolves ? item(id) : null
  },
  get getBlockers() {
    if (!supportsBlockers) return undefined
    return async (issue: { id: string }): Promise<Blocker[]> => {
      getBlockersCalls.push(issue.id)
      if (issue.id === failFor) throw new Error('GitHub caído')
      return issue.id === 'a' ? [{ id: 'x', ref: '#1236', title: 'otro' }] : []
    }
  },
}

mock.module('../../composition/container.js', () => ({
  projectRepo: { get: (id: string) => (id === 'p1' ? { id: 'p1' } : null) },
  sourceFactory: { get: () => source },
}))

const { createProjectSourceRouter } = await import('../project-source.js')

function request(path: string) {
  // El router se monta bajo /api/projects/:id/source, así que el :id ya está
  // resuelto por el padre — acá se pasa por el mismo camino con un app mínimo.
  const { Hono } = require('hono') as typeof import('hono')
  const app = new Hono()
  app.route('/api/projects/:id/source', createProjectSourceRouter())
  return app.request(`/api/projects/p1/source${path}`)
}

function reset() {
  getBlockersCalls = []
  lookedUp = []
  lookupResolves = true
  getItemsCalls = 0
  failFor = null
  supportsBlockers = true
}

describe('GET /blockers — batch', () => {
  test('resuelve los items UNA vez y devuelve un mapa por id', async () => {
    reset()
    const res = await request('/blockers?ids=a,b')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { blockers: Record<string, Blocker[]> }
    expect(getItemsCalls).toBe(1)
    expect(body.blockers.a).toHaveLength(1)
    expect(body.blockers.b).toEqual([])
    // `c` no se pidió: el batch no trae de más.
    expect(body.blockers.c).toBeUndefined()
  })

  // "No sé" no es "no hay": si la fuente falla para un item, su clave NO
  // aparece, y la UI no puede afirmar que esa tarea está desbloqueada.
  test('un item que falla se omite del mapa sin tirar el resto', async () => {
    reset()
    failFor = 'a'
    const res = await request('/blockers?ids=a,b')
    const body = (await res.json()) as { blockers: Record<string, Blocker[]> }
    expect(res.status).toBe(200)
    expect(body.blockers.a).toBeUndefined()
    expect(body.blockers.b).toEqual([])
  })

  // Una fuente sin dependencias no está rota: contesta un mapa vacío.
  test('una fuente sin getBlockers devuelve un mapa vacío, no un error', async () => {
    reset()
    supportsBlockers = false
    const res = await request('/blockers?ids=a')
    expect(res.status).toBe(200)
    expect((await res.json()).blockers).toEqual({})
  })

  test('sin ids es un 400', async () => {
    reset()
    expect((await request('/blockers')).status).toBe(400)
  })

  test('un batch desmedido se rechaza en vez de golpear la fuente', async () => {
    reset()
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`).join(',')
    expect((await request(`/blockers?ids=${ids}`)).status).toBe(400)
    expect(getItemsCalls).toBe(0)
  })

  // El snapshot de `getItems` puede no traer un id (filtrado por la fuente,
  // cerrado, fuera de su página). Se reintenta por lookup directo: si no, el
  // batch contradice a la ruta por item sobre la misma tarea.
  test('un id fuera del snapshot se resuelve por lookup directo', async () => {
    reset()
    const res = await request('/blockers?ids=a,z')
    const body = (await res.json()) as { blockers: Record<string, Blocker[]> }
    expect(lookedUp).toEqual(['z'])
    expect(Object.keys(body.blockers).sort()).toEqual(['a', 'z'])
  })

  test('un id que no existe en ningún lado no aparece — ausencia es "no sé"', async () => {
    reset()
    lookupResolves = false
    const res = await request('/blockers?ids=a,fantasma')
    const body = (await res.json()) as { blockers: Record<string, Blocker[]> }
    expect(Object.keys(body.blockers)).toEqual(['a'])
    expect(getBlockersCalls).toEqual(['a'])
  })
})
