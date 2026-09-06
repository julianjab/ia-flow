import { describe, expect, test } from 'bun:test'
import type { EngineEvent, Rule } from '@ia-flow/shared'
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
    rules?: Rule[]
    baseWhen?: unknown[]
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
  const useCase = new RunTaskNowUseCase(bus, () => opts.running === true, {
    loadRules: async () => opts.rules ?? [],
    loadBaseWhen: async () => opts.baseWhen ?? [],
  })
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

// Un run que NUNCA arranca no deja fila en execution_logs ni comentario: su
// única huella era una línea "Rules NOT matched" en el daemon.log. El preview
// es esa línea, contestada antes de apretar el botón.
describe('RunTaskNowUseCase.preview', () => {
  const buildRule = (over: Partial<Rule> = {}): Rule =>
    ({
      id: 'ia-flow-build',
      name: 'ia-flow · build → implementer',
      on: ['issue.created', 'issue.status_changed'],
      when: [{ field: 'status', op: '=', value: 'build' }],
      actions: [{ action: 'agent', agentId: 'implementer' }],
      enabled: true,
      position: 1,
      ...over,
    }) as Rule

  test('nombra la regla que la va a tomar', async () => {
    const { useCase, source, published } = harness({ rules: [buildRule()] })
    const preview = await useCase.preview({ taskId: 'I_1', projectId: 'ia-flow' }, source)
    expect(preview.status).toBe('build')
    expect(preview.matched).toEqual([
      { id: 'ia-flow-build', name: 'ia-flow · build → implementer' },
    ])
    expect(preview.blockedReason).toBeNull()
    // Diagnóstico puro: mirar no despacha nada.
    expect(published).toHaveLength(0)
  })

  // El caso que motivó todo: la condición que falló y con qué valor, que es lo
  // que distingue "el status no es ése" de "el evento no trae ese campo".
  test('cuando ninguna matchea, dice qué condición falló y contra qué valor', async () => {
    const rules = [buildRule({ when: [{ field: 'status', op: '=', value: 'review' }] })]
    const { useCase, source } = harness({ rules })
    const preview = await useCase.preview({ taskId: 'I_1', projectId: 'ia-flow' }, source)
    expect(preview.matched).toEqual([])
    expect(preview.rejected[0]).toMatchObject({ id: 'ia-flow-build', reason: 'when' })
    expect(preview.rejected[0].failed?.[0]).toMatchObject({
      field: 'status',
      value: 'review',
      actual: 'build',
    })
  })

  // Las reglas de otros proyectos o de otro tipo de evento se cuentan, no se
  // listan: enterrarían el motivo real bajo todas las reglas del deploy.
  test('los descartes no accionables se cuentan aparte', async () => {
    const rules = [buildRule({ id: 'otro-proyecto', projectId: 'subscriptions' }), buildRule()]
    const { useCase, source } = harness({ rules })
    const preview = await useCase.preview({ taskId: 'I_1', projectId: 'ia-flow' }, source)
    expect(preview.matched.map((r) => r.id)).toEqual(['ia-flow-build'])
    expect(preview.rejected).toEqual([])
    expect(preview.notApplicable).toBe(1)
  })

  test('una regla apagada sale como descarte accionable', async () => {
    const { useCase, source } = harness({ rules: [buildRule({ enabled: false })] })
    const preview = await useCase.preview({ taskId: 'I_1', projectId: 'ia-flow' }, source)
    expect(preview.rejected[0]).toMatchObject({ reason: 'disabled' })
  })

  // Un run en curso no impide matchear: lo que se informa es que el pedido no
  // llegaría a despachar igual. Las dos cosas son útiles a la vez.
  test('con un run en curso lo dice, y aún así evalúa las reglas', async () => {
    const { useCase, source } = harness({ running: true, rules: [buildRule()] })
    const preview = await useCase.preview({ taskId: 'I_1', projectId: 'ia-flow' }, source)
    expect(preview.blockedReason).toContain('run en curso')
    expect(preview.matched).toHaveLength(1)
  })

  test('sin status contesta el motivo sin evaluar nada', async () => {
    const { useCase, source } = harness({ item: { ...ITEM, status: '' }, rules: [buildRule()] })
    const preview = await useCase.preview({ taskId: 'I_1', projectId: 'ia-flow' }, source)
    expect(preview.blockedReason).toContain('no tiene status')
    expect(preview.matched).toEqual([])
    expect(preview.rejected).toEqual([])
  })
})
