import { describe, expect, it } from 'bun:test'
import type { AssistantScope, ImprovementProposal, InboxItem } from '@ia-flow/shared'
import { type AssistantBackend, AssistantSession } from './AssistantSession.js'
import type { TraceInsight } from './TraceInsight.js'

const merge: InboxItem = {
  ref: 'o/r#1',
  project_id: 'p',
  title: 'Mergear',
  url: 'u',
  group: 'need',
  kind: 'merge',
  labels: [],
  why: 'Review + reviewed',
  since: '2026-09-29T10:00:00Z',
  unlocks: 2,
  epic: { ref: 'o/r#9', title: 'Bandeja', done: 1, total: 4 },
  priority: 1,
  reasons: ['a un merge de Done', 'destraba 2 tareas'],
  actions: ['merge'],
}

const backend = {
  inbox: { inbox: async () => ({ items: [merge] }) },
} as unknown as AssistantBackend

describe('AssistantSession.listTasks', () => {
  it('each task says its place in the order, why, and how much it unblocks', async () => {
    const session = new AssistantSession({ kind: 'general' }, backend, () => {})
    const [first] = (await session.listTasks()).tasks
    expect(first).toMatchObject({
      ref: 'o/r#1',
      priority: 1,
      reasons: ['a un merge de Done', 'destraba 2 tareas'],
      unlocks: 2,
    })
  })

  it('each task says its epic and how far along it is', async () => {
    const session = new AssistantSession({ kind: 'general' }, backend, () => {})
    const [first] = (await session.listTasks()).tasks
    expect(first?.epic).toEqual({ ref: 'o/r#9', title: 'Bandeja', done: 1, total: 4 })
  })
})

describe('AssistantSession: la hora, el último paso y cada agente', () => {
  const NOW = new Date('2026-10-16T10:10:00.000Z')
  const running = {
    id: 'e9',
    key: 'k',
    task_ref: 'o/r#1',
    project_id: 'p',
    pipeline_id: 'review',
    status: 'running' as const,
    started_at: '2026-10-16T10:00:00.000Z',
  }
  const searches: unknown[] = []
  const traces: TraceInsight = {
    lastStepAt: (ids) => new Map(ids.map((id) => [id, '2026-10-16T10:08:00.000Z'])),
    agentRuns: () => [
      {
        agent_id: 'reviewer',
        started_at: '2026-10-16T10:00:00.000Z',
        ended_at: '2026-10-16T10:04:00.000Z',
        status: 'ok',
        exit: 'approve',
        last_step_at: '2026-10-16T10:04:00.000Z',
      },
      {
        agent_id: 'e2e-visual-qa',
        started_at: '2026-10-16T10:00:00.000Z',
        last_step_at: '2026-10-16T10:08:00.000Z',
      },
    ],
    search: (query) => {
      searches.push(query)
      return { executions: [], truncated: false }
    },
  }
  const live = { ...merge, group: 'run' as const, execution: running }
  const backend = {
    inbox: {
      inbox: async () => ({ items: [live] }),
      item: async () => live,
      detail: async () => ({ item: live, executions: [running], events: [], trace: [] }),
    },
    activity: {
      executions: () => [running, { ...running, id: 'e8', task_ref: 'o/r#2', project_id: 'q' }],
      trace: () => [],
    },
    status: () => ({ providers: ['anthropic-api'] }),
    traces,
    now: () => NOW,
  } as unknown as AssistantBackend
  const session = (scope: AssistantScope) => new AssistantSession(scope, backend, () => {})

  it('list_tasks says the time and, for a live execution, how long since its last step', async () => {
    const listed = await session({ kind: 'general' }).listTasks()
    expect(listed.now).toBe('2026-10-16T10:10:00.000Z')
    expect(listed.tasks[0]).toMatchObject({
      running: {
        execution_id: 'e9',
        last_step_at: '2026-10-16T10:08:00.000Z',
        idle_seconds: 120,
        agents: [
          { agent_id: 'reviewer', state: 'done', exit: 'approve' },
          { agent_id: 'e2e-visual-qa', state: 'running', idle_seconds: 120 },
        ],
      },
    })
  })

  it('get_task tells the agents of a parallel group apart', async () => {
    const detail = await session({ kind: 'general' }).taskDetail('o/r#1')
    expect(detail.now).toBe('2026-10-16T10:10:00.000Z')
    expect(detail.executions[0]).toMatchObject({
      idle_seconds: 120,
      agents: [{ state: 'done' }, { state: 'running' }],
    })
  })

  it('get_trace of a live execution says the time and its last step', async () => {
    const page = await session({ kind: 'general' }).trace('o/r#1', 'e9')
    expect(page).toMatchObject({
      now: '2026-10-16T10:10:00.000Z',
      status: 'running',
      idle_seconds: 120,
      execution_id: 'e9',
    })
  })

  it('runner_status works in every context, with the live executions of that context', () => {
    const general = session({ kind: 'general' }).status()
    expect(general).toMatchObject({ now: '2026-10-16T10:10:00.000Z', providers: ['anthropic-api'] })
    expect(general.live_executions.map((row) => row.id)).toEqual(['e9', 'e8'])
    const project = session({ kind: 'project', project_id: 'q' }).status()
    expect(project.live_executions.map((row) => row.id)).toEqual(['e8'])
    const task = session({ kind: 'task', ref: 'o/r#1' }).status()
    expect(task.live_executions).toEqual([
      expect.objectContaining({ id: 'e9', idle_seconds: 120, agents: expect.any(Array) }),
    ])
  })

  it('search_traces is bound to the task or the project of the context', () => {
    searches.length = 0
    session({ kind: 'task', ref: 'o/r#1' }).searchTraces({ text: 'pause_turn' })
    session({ kind: 'project', project_id: 'p' }).searchTraces({ text: 'pause_turn' })
    const found = session({ kind: 'general' }).searchTraces({ text: 'pause_turn' })
    expect(found.now).toBe('2026-10-16T10:10:00.000Z')
    expect(searches).toEqual([
      expect.objectContaining({ taskRef: 'o/r#1' }),
      expect.objectContaining({ projectId: 'p' }),
      expect.not.objectContaining({ taskRef: expect.anything() }),
    ])
  })
})

describe('AssistantSession en el contexto de una tarea cerrada', () => {
  // Se pregunta por una mejora de la retrospectiva: la tarea ya salió del board con el merge.
  const executions = [{ id: 'e2', task_ref: 'o/r#5' }]
  const closed = {
    inbox: { item: async () => undefined, detail: async () => undefined },
    activity: {
      executions: () => executions,
      eventsForTask: () => [{ type: 'pull_request.closed' }],
      trace: () => [{ kind: 'log', name: 'propongo documentar los tests', attributes: {} }],
    },
  } as unknown as AssistantBackend

  it('get_task trae sus ejecuciones y la traza de la última', async () => {
    const session = new AssistantSession({ kind: 'task', ref: 'o/r#5' }, closed, () => {})
    const detail = await session.taskDetail('o/r#5')
    expect(detail.item).toMatchObject({ ref: 'o/r#5' })
    expect(detail.executions.map((execution) => execution.id)).toEqual(['e2'])
    expect(detail.trace).toHaveLength(1)
  })

  it('la traza de una de sus ejecuciones se lee', async () => {
    const session = new AssistantSession({ kind: 'task', ref: 'o/r#5' }, closed, () => {})
    await expect(session.trace('o/r#5', 'e2')).resolves.toBeDefined()
  })

  it('otra tarea sigue fuera de contexto', async () => {
    const session = new AssistantSession({ kind: 'task', ref: 'o/r#5' }, closed, () => {})
    await expect(session.taskDetail('o/r#6')).rejects.toThrow(/Fuera de contexto/)
  })

  it('en el contexto general, una tarea fuera del board no se lee', async () => {
    const session = new AssistantSession({ kind: 'general' }, closed, () => {})
    await expect(session.taskDetail('o/r#5')).rejects.toThrow(/no está en ningún board/)
  })
})

describe('AssistantSession: ajustar o agregar una mejora', () => {
  const base: ImprovementProposal = {
    id: 'm1',
    created_at: '2026-10-15T09:00:00Z',
    task_ref: 'o/r#5',
    pr_url: 'https://github.com/o/r/pull/9',
    agent: 'retrospective',
    execution_id: 'e2',
    target: 'engine',
    repo: 'o/ia-flow',
    title: 'Viejo',
    body: 'cuerpo',
    reason: 'porque',
    status: 'open',
  }
  function withStore(found: ImprovementProposal[] = [base]) {
    const revised: unknown[] = []
    const added: unknown[] = []
    const backend = {
      improvements: {
        get: (id: string) => found.find((m) => m.id === id),
        revise: (id: string, changes: unknown) => {
          revised.push({ id, changes })
          return base
        },
        findOpen: () => undefined,
        add: (input: Record<string, unknown>) => {
          added.push(input)
          return { ...base, ...input, id: 'm2' }
        },
        list: () => [],
      },
    } as unknown as AssistantBackend
    return { backend, revised, added }
  }

  it('ajusta una pendiente de la tarea del contexto, sólo con lo que viene', () => {
    const { backend, revised } = withStore()
    const session = new AssistantSession({ kind: 'task', ref: 'o/r#5' }, backend, () => {})
    expect(session.reviseImprovement({ id: 'm1', title: 'Nuevo' })).toContain('Mejora m1 ajustada')
    expect(revised).toEqual([{ id: 'm1', changes: { title: 'Nuevo' } }])
  })

  it('no ajusta una de otra tarea, una ya decidida, ni sin cambios', () => {
    const { backend } = withStore([base, { ...base, id: 'm3', status: 'dismissed' }])
    const session = new AssistantSession({ kind: 'task', ref: 'o/r#6' }, backend, () => {})
    expect(() => session.reviseImprovement({ id: 'm1', title: 'x' })).toThrow(/Fuera de contexto/)
    const general = new AssistantSession({ kind: 'general' }, backend, () => {})
    expect(() => general.reviseImprovement({ id: 'm3', title: 'x' })).toThrow(/ya se descartó/)
    expect(() => general.reviseImprovement({ id: 'm1' })).toThrow(/nada que ajustar/)
  })

  it('una nueva hereda el destino, la tarea y la evidencia de la base', async () => {
    const { backend, added } = withStore()
    const session = new AssistantSession({ kind: 'task', ref: 'o/r#5' }, backend, () => {})
    const result = await session.addImprovement({
      based_on: 'm1',
      title: 'Otra',
      body: 'b',
      reason: 'r',
    })
    expect(result).toContain('Mejora m2 guardada')
    expect(added).toEqual([
      {
        task_ref: 'o/r#5',
        pr_url: 'https://github.com/o/r/pull/9',
        agent: 'assistant',
        execution_id: 'e2',
        target: 'engine',
        repo: 'o/ia-flow',
        title: 'Otra',
        body: 'b',
        reason: 'r',
      },
    ])
  })

  it('sin mejoras en la bandeja, una nueva sale de la tarea del contexto y va al repo pedido', async () => {
    const { backend, added } = withStore([])
    const session = new AssistantSession({ kind: 'task', ref: 'o/r#5' }, backend, () => {})
    const result = await session.addImprovement({
      repo: 'o/ia-flow',
      target: 'config',
      title: 'Nueva',
      body: 'b',
      reason: 'r',
    })
    expect(result).toContain('Mejora m2 guardada')
    expect(result).not.toContain('se diferencia')
    expect(added).toEqual([
      {
        task_ref: 'o/r#5',
        agent: 'assistant',
        target: 'config',
        repo: 'o/ia-flow',
        title: 'Nueva',
        body: 'b',
        reason: 'r',
      },
    ])
  })

  it('sin base, en el contexto general la tarea es opcional pero tiene que estar en el board', async () => {
    const { backend, added } = withStore([])
    const withInbox = {
      ...backend,
      inbox: { item: async (ref: string) => (ref === 'o/r#1' ? merge : undefined) },
    } as unknown as AssistantBackend
    const session = new AssistantSession({ kind: 'general' }, withInbox, () => {})
    const input = { repo: 'o/ia-flow', title: 'Nueva', body: 'b', reason: 'r' }
    await expect(session.addImprovement({ ...input, repo: 'ia-flow' })).rejects.toThrow(
      /necesita repo/,
    )
    await expect(
      session.addImprovement({ ...input, repo: 'ia-flow', task_ref: 'o/r#1' }),
    ).rejects.toThrow(/necesita repo/)
    await expect(session.addImprovement({ ...input, task_ref: 'o/r#7' })).rejects.toThrow(
      /no está en ningún board/,
    )
    await session.addImprovement({ ...input, task_ref: 'o/r#1' })
    expect(added).toEqual([expect.objectContaining({ task_ref: 'o/r#1', target: 'engine' })])
  })

  it('sin base ni tarea, en el contexto general la guarda sin tarea', async () => {
    const { backend, added } = withStore([])
    const session = new AssistantSession({ kind: 'general' }, backend, () => {})
    const result = await session.addImprovement({
      repo: 'o/deploy',
      target: 'config',
      title: 'Darle memoria a todos los agentes',
      body: 'b',
      reason: 'r',
    })
    expect(result).toContain('guardada')
    expect(added).toEqual([
      {
        agent: 'assistant',
        target: 'config',
        repo: 'o/deploy',
        title: 'Darle memoria a todos los agentes',
        body: 'b',
        reason: 'r',
      },
    ])
  })

  it('sin base ni tarea, en el contexto de un proyecto la guarda sin tarea', async () => {
    const { backend, added } = withStore([])
    const session = new AssistantSession({ kind: 'project', project_id: 'p' }, backend, () => {})
    await session.addImprovement({ repo: 'o/ia-flow', title: 'Nueva', body: 'b', reason: 'r' })
    expect(added).toHaveLength(1)
    expect(added[0]).not.toHaveProperty('task_ref')
  })

  it('sin base, en el contexto de una tarea no sale de otra', async () => {
    const { backend } = withStore([])
    const session = new AssistantSession({ kind: 'task', ref: 'o/r#5' }, backend, () => {})
    await expect(
      session.addImprovement({
        task_ref: 'o/r#6',
        repo: 'o/x',
        title: 't',
        body: 'b',
        reason: 'r',
      }),
    ).rejects.toThrow(/Fuera de contexto/)
  })
})
