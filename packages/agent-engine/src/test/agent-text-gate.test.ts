import { beforeEach, describe, expect, it } from 'bun:test'
import { SYSTEM_COMMENT_MARKER } from '@ia-flow/issue-sources'
import type { AgentDefinition, Task, TaskComment } from '@ia-flow/shared'
import {
  type AgentTextClassifier,
  clearAgentTextVerdicts,
  renderConversationWindow,
  selectAgentGated,
} from '../agent-text-gate.js'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Add login',
    description: 'desc',
    type: 'functional',
    repos: ['backend'],
    status: 'Build',
    created_at: '2026-01-01T00:00:00Z',
    projectId: 'proj-1',
    ...overrides,
  }
}

function agent(id: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    provider: 'anthropic-api',
    prompt: 'p',
    projectId: 'proj-1',
    statusName: 'Build',
    ...overrides,
  } as AgentDefinition
}

/** Clasificador de fixture: devuelve lo que se le diga y cuenta sus llamadas. */
function stubClassifier(verdicts: Record<string, boolean | null>) {
  const calls: string[] = []
  const conversations: Array<string | undefined> = []
  const classify: AgentTextClassifier = async ({ agent: a, conversation }) => {
    calls.push(a.id)
    conversations.push(conversation)
    return verdicts[a.id] ?? null
  }
  return { classify, calls, conversations }
}

/** Comentario de la conversación de una task. */
function comment(body: string, overrides: Partial<TaskComment> = {}): TaskComment {
  return { body, created_at: '2026-01-02T00:00:00Z', ...overrides }
}

/** Un comentario tal como lo escribe el engine al cerrar un run de `agentId`
 *  — es contra esto que `selectCommentWindow` corta la ventana. */
function agentComment(agentId: string, body: string): TaskComment {
  return comment(`# ${agentId}\n\n${body}\n${SYSTEM_COMMENT_MARKER}`)
}

describe('selectAgentGated', () => {
  // El cache de veredictos es global al proceso a propósito (ver el doc del
  // módulo), así que hay que limpiarlo entre tests o se filtran veredictos.
  beforeEach(() => clearAgentTextVerdicts())

  it('sin classify inyectado, whenText no filtra — comportamiento previo al gate', async () => {
    const a = agent('e2e', { whenText: 'sólo si requiere pruebas e2e' })
    const { agent: picked } = await selectAgentGated({ task: task(), agents: [a], status: 'Build' })
    expect(picked?.id).toBe('e2e')
  })

  it('un candidato sin whenText se elige sin consultar al clasificador', async () => {
    const { classify, calls } = stubClassifier({})
    const { agent: picked } = await selectAgentGated({
      task: task(),
      agents: [agent('build')],
      status: 'Build',
      classify,
    })
    expect(picked?.id).toBe('build')
    expect(calls).toEqual([])
  })

  it('whenText que matchea → el agente se elige', async () => {
    const { classify, calls } = stubClassifier({ e2e: true })
    const a = agent('e2e', { whenText: 'requiere e2e' })
    const { agent: picked } = await selectAgentGated({
      task: task(),
      agents: [a],
      status: 'Build',
      classify,
    })
    expect(picked?.id).toBe('e2e')
    expect(calls).toEqual(['e2e'])
  })

  it('whenText que NO matchea descarta al agente aunque sea el único candidato', async () => {
    // Ésta es la diferencia contra el whenText de providers, que sólo desempata
    // y nunca puede rechazar al único que hay.
    const { classify } = stubClassifier({ e2e: false })
    const a = agent('e2e', { whenText: 'requiere e2e' })
    const { agent: picked, rejected } = await selectAgentGated({
      task: task(),
      agents: [a],
      status: 'Build',
      classify,
    })
    expect(picked).toBeNull()
    expect(rejected).toEqual([{ id: 'e2e', reason: 'whenText' }])
  })

  it('descartado por whenText → se prueba el siguiente candidato', async () => {
    const { classify, calls } = stubClassifier({ e2e: false })
    const agents = [
      agent('e2e', { position: 0, whenText: 'requiere e2e' }),
      agent('fallback', { position: 1 }),
    ]
    const { agent: picked, rejected } = await selectAgentGated({
      task: task(),
      agents,
      status: 'Build',
      classify,
    })
    expect(picked?.id).toBe('fallback')
    expect(rejected).toEqual([{ id: 'e2e', reason: 'whenText' }])
    expect(calls).toEqual(['e2e'])
  })

  it('el clasificador que no puede decidir aborta la selección — no cae al siguiente', async () => {
    // `null` es "no sé", no "no aplica": elegir al de abajo sería resolver por
    // descarte con información faltante. Se skipea el dispatch y el próximo
    // scan reintenta, igual que hace resolveProvider.
    const { classify } = stubClassifier({ e2e: null })
    const agents = [
      agent('e2e', { position: 0, whenText: 'requiere e2e' }),
      agent('fallback', { position: 1 }),
    ]
    const { agent: picked } = await selectAgentGated({
      task: task(),
      agents,
      status: 'Build',
      classify,
    })
    expect(picked).toBeNull()
  })

  it('los filtros estructurales corren antes — un agente que no matchea nunca llega al clasificador', async () => {
    const { classify, calls } = stubClassifier({ e2e: true })
    const a = agent('e2e', { statusName: 'Otro', whenText: 'requiere e2e' })
    const { agent: picked, rejected } = await selectAgentGated({
      task: task(),
      agents: [a],
      status: 'Build',
      classify,
    })
    expect(picked).toBeNull()
    expect(rejected).toEqual([{ id: 'e2e', reason: 'status' }])
    expect(calls).toEqual([])
  })

  it('el veredicto se cachea: el mismo issue no vuelve a consultar al clasificador', async () => {
    // Sin esto, un issue parado en el estado que activa al agente (justo lo que
    // pasa cuando el veredicto es "no aplica") consultaría a Haiku en cada scan.
    const { classify, calls } = stubClassifier({ e2e: false })
    const a = agent('e2e', { whenText: 'requiere e2e' })
    const input = { task: task(), agents: [a], status: 'Build', classify }
    await selectAgentGated(input)
    await selectAgentGated(input)
    await selectAgentGated(input)
    expect(calls).toEqual(['e2e'])
  })

  it('cambiar la descripción del issue invalida el veredicto cacheado', async () => {
    const { classify, calls } = stubClassifier({ e2e: false })
    const a = agent('e2e', { whenText: 'requiere e2e' })
    await selectAgentGated({ task: task(), agents: [a], status: 'Build', classify })
    await selectAgentGated({
      task: task({ description: 'ahora sí toca un handler de eventos' }),
      agents: [a],
      status: 'Build',
      classify,
    })
    expect(calls).toEqual(['e2e', 'e2e'])
  })

  it('cambiar el whenText del agente invalida el veredicto cacheado', async () => {
    const { classify, calls } = stubClassifier({ e2e: false })
    await selectAgentGated({
      task: task(),
      agents: [agent('e2e', { whenText: 'criterio viejo' })],
      status: 'Build',
      classify,
    })
    await selectAgentGated({
      task: task(),
      agents: [agent('e2e', { whenText: 'criterio nuevo' })],
      status: 'Build',
      classify,
    })
    expect(calls).toEqual(['e2e', 'e2e'])
  })

  it('un veredicto "no sé" no se cachea — el próximo scan vuelve a preguntar', async () => {
    const { classify, calls } = stubClassifier({ e2e: null })
    const input = {
      task: task(),
      agents: [agent('e2e', { whenText: 'x' })],
      status: 'Build',
      classify,
    }
    await selectAgentGated(input)
    await selectAgentGated(input)
    expect(calls).toEqual(['e2e', 'e2e'])
  })

  it('un comentario nuevo invalida el veredicto cacheado', async () => {
    // El caso que motivó pasar la conversación por la key: sin ella, el "no
    // aplica" del primer scan se cachea para siempre. Nada más cambia (el gate
    // dijo que no, así que el issue no se mueve de estado), así que el
    // comentario que SÍ debería activarlo nunca se llega a evaluar.
    const { classify, calls } = stubClassifier({ validator: false })
    const a = agent('validator', { whenText: 'el último comentario pide un cambio de enfoque' })

    await selectAgentGated({ task: task(), agents: [a], status: 'Build', classify })
    // Mismo issue, mismo criterio, un comentario nuevo.
    await selectAgentGated({
      task: task({ comments: [comment('esto no va por acá, replanteemos')] }),
      agents: [a],
      status: 'Build',
      classify,
    })

    expect(calls).toEqual(['validator', 'validator'])
  })

  it('sin comentarios nuevos el veredicto se sigue cacheando', async () => {
    const { classify, calls } = stubClassifier({ validator: false })
    const a = agent('validator', { whenText: 'x' })
    const input = {
      task: task({ comments: [comment('mismo comentario de siempre')] }),
      agents: [a],
      status: 'Build',
      classify,
    }

    await selectAgentGated(input)
    await selectAgentGated(input)

    expect(calls).toEqual(['validator'])
  })

  it('le pasa al clasificador sólo lo que el agente todavía no vio', async () => {
    const { classify, conversations } = stubClassifier({ validator: true })
    const t = task({
      comments: [
        comment('feedback viejo, ya atendido'),
        agentComment('validator', 'listo, lo revisé'),
        comment('el enfoque cambió', { author: 'ana', origin: 'pr', prNumber: 42 }),
      ],
    })

    await selectAgentGated({
      task: t,
      agents: [agent('validator', { whenText: 'x' })],
      status: 'Build',
      classify,
    })

    expect(conversations[0]).toContain('el enfoque cambió')
    expect(conversations[0]).toContain('PR #42')
    expect(conversations[0]).toContain('ana')
    expect(conversations[0]).not.toContain('feedback viejo')
  })
})

describe('renderConversationWindow', () => {
  it('sin comentarios nuevos devuelve vacío', () => {
    const t = task({ comments: [agentComment('validator', 'ya está')] })
    expect(renderConversationWindow(t, 'validator')).toBe('')
  })

  it('un issue sin comentarios devuelve vacío', () => {
    expect(renderConversationWindow(task(), 'validator')).toBe('')
  })

  it('ubica una review en su archivo y línea', () => {
    const t = task({
      comments: [
        comment('esto pierde el lock', {
          origin: 'pr-review',
          prNumber: 7,
          path: 'core/twilio.py',
          line: 88,
        }),
      ],
    })
    expect(renderConversationWindow(t, 'validator')).toContain('PR #7 · review · core/twilio.py:88')
  })

  it('recorta la ventana larga por el principio, conservando lo reciente', () => {
    const comments = Array.from({ length: 40 }, (_, i) =>
      comment(`comentario ${i} ${'x'.repeat(500)}`),
    )
    const out = renderConversationWindow(task({ comments }), 'validator')

    expect(out.length).toBeLessThan(4200)
    expect(out).toStartWith('…')
    expect(out).toContain('comentario 39')
    expect(out).not.toContain('comentario 0 ')
  })
})
