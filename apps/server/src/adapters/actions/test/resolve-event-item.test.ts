import { describe, expect, test } from 'bun:test'
import type { ProjectSource, SourceItem } from '@ia-flow/issue-sources'
import { createResolveEventItem } from '../resolve-event-item.js'

// Lo que se testea es el contrato de la búsqueda: qué camino toma según lo que
// el scope trae, y que un "no encontrado" sea `undefined` y no un throw — un
// PR sin issue linkeado es un caso normal, no un error.

const ITEM: SourceItem = {
  id: 'PVTI_1',
  title: 'una task',
  status: 'Build',
  meta: {
    issueNumber: 7,
    pullRequests: [{ number: 482, url: 'u', state: 'open', isDraft: false }],
  },
} as unknown as SourceItem

function source(over: Partial<ProjectSource> = {}): ProjectSource {
  return {
    getItems: async () => [ITEM],
    ...over,
  } as unknown as ProjectSource
}

const resolver = (s: ProjectSource) => createResolveEventItem({ sourceFor: () => s })

describe('resolveEventItem', () => {
  test('con issueId usa el lookup directo, sin listar el board', async () => {
    let listed = 0
    const s = source({
      getItemById: async (id: string) => (id === 'PVTI_1' ? ITEM : null),
      getItems: async () => {
        listed++
        return [ITEM]
      },
    })
    const item = await resolver(s)('p1', { projectId: 'p1', issueId: 'PVTI_1' })
    expect(item?.id).toBe('PVTI_1')
    expect(listed).toBe(0)
  })

  // Un issueId que la fuente no conoce es de otro board: barrer no lo va a
  // encontrar, y hacerlo cobraría una consulta completa por cada delivery.
  test('un issueId desconocido devuelve undefined sin caer al escaneo', async () => {
    let listed = 0
    const s = source({
      getItemById: async () => null,
      getItems: async () => {
        listed++
        return [ITEM]
      },
    })
    expect(await resolver(s)('p1', { projectId: 'p1', issueId: 'nope' })).toBeUndefined()
    expect(listed).toBe(0)
  })

  test('con prNumber encuentra el issue que linkea ese PR', async () => {
    const item = await resolver(source())('p1', { projectId: 'p1', prNumber: 482 })
    expect(item?.id).toBe('PVTI_1')
  })

  // El caso normal de un PR abierto a mano: no es un error, simplemente no hay
  // agente que correr.
  test('un PR que ningún issue linkea devuelve undefined', async () => {
    expect(await resolver(source())('p1', { projectId: 'p1', prNumber: 999 })).toBeUndefined()
  })

  // Varios repos mapean al mismo projectId y cada uno numera sus PRs desde 1,
  // así que el número solo NO identifica un PR. Resolver el issue equivocado no
  // es un no-op: el agente le comenta y le mueve el status.
  test('desambigua por repo cuando dos issues linkean el mismo número', async () => {
    const a = { ...ITEM, id: 'PVTI_a', repos: 'repo-a' } as SourceItem
    const b = { ...ITEM, id: 'PVTI_b', repos: 'repo-b' } as SourceItem
    const s = source({ getItems: async () => [a, b] })
    const item = await resolver(s)('p1', { projectId: 'p1', prNumber: 482, repos: ['repo-b'] })
    expect(item?.id).toBe('PVTI_b')
  })

  test('desambigua por el repo que hostea el issue cuando no hay campo Repos', async () => {
    const a = { ...ITEM, id: 'PVTI_a', meta: { ...ITEM.meta, repoName: 'repo-a' } } as SourceItem
    const b = { ...ITEM, id: 'PVTI_b', meta: { ...ITEM.meta, repoName: 'repo-b' } } as SourceItem
    const s = source({ getItems: async () => [a, b] })
    const item = await resolver(s)('p1', { projectId: 'p1', prNumber: 482, repos: ['repo-a'] })
    expect(item?.id).toBe('PVTI_a')
  })

  // Elegir uno al azar dejaría comentarios y movería una card que nadie tocó.
  // El scan lo levanta después por el camino normal.
  test('si sigue habiendo más de un candidato no corre nada', async () => {
    const a = { ...ITEM, id: 'PVTI_a', repos: 'repo-a' } as SourceItem
    const b = { ...ITEM, id: 'PVTI_b', repos: 'repo-a' } as SourceItem
    const s = source({ getItems: async () => [a, b] })
    const item = await resolver(s)('p1', { projectId: 'p1', prNumber: 482, repos: ['repo-a'] })
    expect(item).toBeUndefined()
  })

  // El caso frecuente Y el peligroso: hay UN solo issue que linkea el #42, pero
  // es el #42 de OTRO repo. "Hay uno solo" no lo vuelve el correcto.
  test('un único candidato de otro repo NO se devuelve', async () => {
    const a = { ...ITEM, id: 'PVTI_a', repos: 'repo-a' } as SourceItem
    const s = source({ getItems: async () => [a] })
    const item = await resolver(s)('p1', { projectId: 'p1', prNumber: 482, repos: ['repo-b'] })
    expect(item).toBeUndefined()
  })

  // Fail-closed: un item que no declara repo por ninguna de las dos vías no
  // puede afirmarse que sea el del evento.
  test('un item sin repo declarado no matchea un scope con repos', async () => {
    const s = source({
      getItems: async () => [{ ...ITEM, meta: { pullRequests: [{ number: 482 }] } } as SourceItem],
    })
    const item = await resolver(s)('p1', { projectId: 'p1', prNumber: 482, repos: ['repo-a'] })
    expect(item).toBeUndefined()
  })

  // Sin `repos` en el scope no hay con qué filtrar: un único match sigue siendo
  // la mejor respuesta disponible.
  test('un único match sin repos en el scope resuelve igual', async () => {
    const item = await resolver(source())('p1', { projectId: 'p1', prNumber: 482 })
    expect(item?.id).toBe('PVTI_1')
  })

  test('sin issueId ni prNumber no hay nada que resolver', async () => {
    expect(await resolver(source())('p1', { projectId: 'p1' })).toBeUndefined()
  })

  // `TaskDispatcher` saltea cualquier item sin projectId, así que estamparlo no
  // es cosmético: sin esto el dispatch se pierde en silencio.
  test('estampa el projectId, que por este camino nadie más pone', async () => {
    const item = await resolver(source())('p1', { projectId: 'p1', prNumber: 482 })
    expect(item?.projectId).toBe('p1')
  })

  // Si la conversión fuera propia, el agente vería un item con otra forma según
  // por qué evento entró.
  test('convierte con el toIssueItem de la fuente cuando existe', async () => {
    const s = source({
      toIssueItem: (raw: SourceItem) =>
        ({ id: raw.id, title: 'CONVERTIDO', repos: ['web'] }) as never,
    })
    const item = await resolver(s)('p1', { projectId: 'p1', prNumber: 482 })
    expect(item?.title).toBe('CONVERTIDO')
    expect(item?.repos).toEqual(['web'])
  })
})
