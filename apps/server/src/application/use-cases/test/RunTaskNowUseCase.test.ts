import { describe, expect, test } from 'bun:test'
import type { EngineEvent } from '@ia-flow/shared'
import type { EventOutcome, IEventBus } from '../../../domain/ports/IEventBus.js'
import type { SourceItem } from '../../../domain/ports/IIssueManager.js'
import { RunTaskNowError, type RunTaskNowSource, RunTaskNowUseCase } from '../RunTaskNowUseCase.js'

const ITEM: SourceItem = {
  id: 'I_1',
  title: 'Tools de filesystem',
  status: 'build',
  repos: 'ia-flow',
  meta: { repoName: 'ia-flow', labels: ['enhancement'] },
}

function harness(
  opts: {
    item?: SourceItem | null
    running?: boolean
    outcome?: EventOutcome
    withGetItemById?: boolean
  } = {},
) {
  const published: EngineEvent[] = []
  const bus: IEventBus = {
    subscribe: () => () => {},
    publish: async (e) => {
      published.push(e)
      return opts.outcome ?? 'dispatched'
    },
  }
  const item = opts.item === undefined ? ITEM : opts.item
  const source: RunTaskNowSource = {
    getItems: async () => (item ? [item] : []),
    ...(opts.withGetItemById === false ? {} : { getItemById: async () => item }),
  }
  const useCase = new RunTaskNowUseCase(bus, () => opts.running === true)
  return { useCase, source, published }
}

describe('RunTaskNowUseCase', () => {
  test('publica un issue.status_changed con el status actual, sin mover la task', async () => {
    const { useCase, source, published } = harness()
    const result = await useCase.execute({ taskId: 'I_1', projectId: 'ia-flow' }, source)

    expect(result).toEqual({ outcome: 'dispatched', status: 'build' })
    expect(published).toHaveLength(1)
    const event = published[0]
    expect(event.type).toBe('issue.status_changed')
    // 'manual' y no 'engine': el hecho lo produjo una persona, y es lo único
    // que distingue este evento de uno del scan en el log.
    expect(event.source).toBe('manual')
    expect(event.scope).toMatchObject({ projectId: 'ia-flow', issueId: 'I_1' })
    // from === to: la task no se movió. Simular un movimiento sería mentir en
    // el payload que las reglas condicionan.
    expect(event.payload).toMatchObject({ from: 'build', to: 'build', status: 'build' })
  })

  // El item viaja mapeado, no crudo: las condiciones `when` de una regla y el
  // dispatch mismo esperan la forma de un IssueItem (repos como lista), que es
  // lo que produce un scan.
  test('el payload lleva el item ya mapeado a IssueItem, como el de un scan', async () => {
    const { useCase, source, published } = harness()
    await useCase.execute({ taskId: 'I_1', projectId: 'ia-flow' }, source)

    const item = published[0].payload.item as { repos: string[]; projectId?: string }
    expect(item.repos).toEqual(['ia-flow'])
    expect(item.projectId).toBe('ia-flow')
  })

  // Una fuente con su propio mapeo gana sobre el default — es la que sabe
  // leer su `meta` (labels, issueNumber, PRs), que es de donde salen la mitad
  // de las condiciones de las reglas.
  test('usa el toIssueItem de la fuente cuando lo tiene', async () => {
    const { useCase, source, published } = harness()
    const withMapper: RunTaskNowSource = {
      ...source,
      toIssueItem: (raw) => ({
        id: raw.id,
        title: raw.title,
        description: '',
        type: '',
        repos: ['mapeado-por-la-fuente'],
        status: raw.status,
        agentWorking: false,
        meta: raw.meta,
      }),
    }
    await useCase.execute({ taskId: 'I_1', projectId: 'ia-flow' }, withMapper)
    const item = published[0].payload.item as { repos: string[] }
    expect(item.repos).toEqual(['mapeado-por-la-fuente'])
  })

  test('rechaza si ya hay un run en curso, sin publicar nada', async () => {
    const { useCase, source, published } = harness({ running: true })
    expect(useCase.execute({ taskId: 'I_1', projectId: 'ia-flow' }, source)).rejects.toBeInstanceOf(
      RunTaskNowError,
    )
    expect(published).toHaveLength(0)
  })

  test('rechaza cuando la task ya no está en el board', async () => {
    const { useCase, source, published } = harness({ item: null })
    expect(useCase.execute({ taskId: 'I_1', projectId: 'ia-flow' }, source)).rejects.toBeInstanceOf(
      RunTaskNowError,
    )
    expect(published).toHaveLength(0)
  })

  // Sin status no hay contra qué evaluar las reglas: el evento saldría, nada
  // matchearía, y desde la UI se vería igual que "el botón no hizo nada".
  test('rechaza cuando la task no tiene status', async () => {
    const { useCase, source } = harness({ item: { ...ITEM, status: '' } })
    expect(useCase.execute({ taskId: 'I_1', projectId: 'ia-flow' }, source)).rejects.toBeInstanceOf(
      RunTaskNowError,
    )
  })

  test('una fuente sin getItemById cae al listado', async () => {
    const { useCase, source, published } = harness({ withGetItemById: false })
    const result = await useCase.execute({ taskId: 'I_1', projectId: 'ia-flow' }, source)
    expect(result.outcome).toBe('dispatched')
    expect(published).toHaveLength(1)
  })

  // El outcome del bus se devuelve tal cual: 'skipped' es "ninguna regla
  // matcheó" y 'deferred' es "no hay capacidad", y son cosas distintas que la
  // tarjeta tiene que poder decir.
  test('propaga el outcome del bus', async () => {
    const { useCase, source } = harness({ outcome: 'skipped' })
    const result = await useCase.execute({ taskId: 'I_1', projectId: 'ia-flow' }, source)
    expect(result.outcome).toBe('skipped')
  })
})
