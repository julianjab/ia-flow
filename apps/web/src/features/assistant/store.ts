import {
  type AssistantAgent,
  type AssistantConversation,
  type AssistantMessage,
  type AssistantProposal,
  type AssistantScope,
  type AssistantStreamEvent,
  DEFAULT_ASSISTANT_AGENT,
  type InboxItem,
  type InboxProject,
  isIssueProposal,
} from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  createIssue,
  executeProposal,
  fetchRunner,
  fetchTasks,
  streamAssistant,
} from '@/features/assistant/api'
import { useGithubSessionStore } from '@/stores/githubSession'

// La conversación del asistente, con UNO de sus agentes (el de siempre, u otro
// que el runner ofrece: `agents`). La página guarda los turnos y manda la
// conversación completa en cada pregunta; con login de GitHub, el runner además
// la guarda (`conversationId`) y se puede retomar desde «Anteriores». Que el drawer esté
// abierto y con qué contexto se pidió vive en `stores/assistant.ts`, para que la
// bandeja lo abra sin importar de esta feature.

export type Turn =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string; activity: string | null; streaming: boolean }
  | {
      id: number
      kind: 'proposal'
      proposal: AssistantProposal
      /** `past`: de una conversación retomada — ya no se ejecuta desde acá. */
      status: 'open' | 'running' | 'done' | 'dismissed' | 'past'
      message?: string
      /** Lo que se creó al ejecutarla (el issue abierto). */
      url?: string
      error?: string
    }
  | { id: number; kind: 'tasks'; items: InboxItem[] }
  | { id: number; kind: 'note'; text: string }

/** Un turno sin su `id` (lo asigna el store); distribuye sobre la unión. */
type NewTurn = Turn extends infer T ? (T extends unknown ? Omit<T, 'id'> : never) : never

/** Cuántos mensajes viajan en cada pregunta: el contexto útil, no un historial infinito. */
const HISTORY_CAP = 20

export const SUGGESTIONS: Record<AssistantScope['kind'], string[]> = {
  general: ['¿Está sano el runner?', '¿Qué debería atender primero?', '¿Qué falló hoy y por qué?'],
  project: [
    '¿Qué debería atender primero?',
    '¿Qué falló hoy y por qué?',
    'Reintentá lo que falló por presupuesto',
  ],
  task: ['¿Qué pasó con esta tarea?', '¿Por qué no corrió nada?', '¿Qué hago ahora?'],
}

/** Las preguntas típicas de los otros agentes del asistente; uno que no está acá no trae. */
export const AGENT_SUGGESTIONS: Record<string, string[]> = {
  'assistant.runner-improvements': [
    '¿Qué falló en el proceso y cómo se evita?',
    '¿Qué agente se está trabando más?',
    '¿Qué issue abrirías para que esto no pase?',
  ],
}

/** Ejecuta una propuesta con el token del usuario: abre el issue, o aplica la acción a la tarea. */
async function execute(
  proposal: AssistantProposal,
  githubToken: string,
): Promise<{ ok: boolean; message: string; url?: string }> {
  return isIssueProposal(proposal)
    ? createIssue(proposal, githubToken)
    : executeProposal(proposal, githubToken)
}

/** Lo que muestra una propuesta para nombrarla en una nota al modelo. */
function proposalTarget(proposal: AssistantProposal): string {
  return isIssueProposal(proposal) ? `"${proposal.title}"` : proposal.ref
}

export function sameScope(a: AssistantScope, b: AssistantScope): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'project' && b.kind === 'project') return a.project_id === b.project_id
  if (a.kind === 'task' && b.kind === 'task') return a.ref === b.ref
  return true
}

export const useAssistantChatStore = defineStore('assistant-chat', () => {
  const scope = ref<AssistantScope>({ kind: 'general' })
  /** Con qué agente del asistente se habla (`AssistantAgent.id`). */
  const agent = ref<string>(DEFAULT_ASSISTANT_AGENT)
  /** Los que ofrece el runner; con uno solo (o un runner viejo, ninguno) no hay qué elegir. */
  const agents = ref<AssistantAgent[]>([])
  const projects = ref<InboxProject[]>([])
  /** Las tareas de la bandeja: de qué se puede hablar con `#` (y los atajos al empezar). */
  const tasks = ref<InboxItem[]>([])
  const turns = ref<Turn[]>([])
  const streaming = ref(false)
  /** La conversación guardada que sigue esta charla; `null` hasta la primera respuesta con login. */
  const conversationId = ref<string | null>(null)
  const session = useGithubSessionStore()

  let history: AssistantMessage[] = []
  /** Lo que el usuario hizo desde la última pregunta: viaja delante de la próxima. */
  let notes: string[] = []
  let abort: AbortController | null = null
  let nextId = 1
  let scopeChosen = false
  /** Sube al cambiar de contexto: un stream viejo no puede escribir en la conversación nueva. */
  let generation = 0

  const suggestions = computed(() =>
    agent.value === DEFAULT_ASSISTANT_AGENT
      ? SUGGESTIONS[scope.value.kind]
      : (AGENT_SUGGESTIONS[agent.value] ?? []),
  )

  const placeholder = computed(() => {
    const s = scope.value
    if (s.kind === 'general') return 'Preguntá sobre todo el runner…'
    return `Preguntá sobre ${s.kind === 'project' ? s.project_id : s.ref}…`
  })

  async function loadProjects(): Promise<void> {
    try {
      const runner = await fetchRunner()
      projects.value = runner.projects
      agents.value = runner.agents
    } catch {
      projects.value = []
      agents.value = []
    }
    // El agente elegido ya no está en este runner: vuelve el de siempre.
    if (!agents.value.some((a) => a.id === agent.value)) setAgent(DEFAULT_ASSISTANT_AGENT)
    try {
      tasks.value = await fetchTasks()
    } catch {
      tasks.value = []
    }
    // Un solo proyecto: es el contexto natural, salvo que ya se haya elegido otro.
    if (!scopeChosen && projects.value.length === 1 && projects.value[0]) {
      scope.value = { kind: 'project', project_id: projects.value[0].id }
    }
  }

  function reset(): void {
    generation++
    stop()
    turns.value = []
    history = []
    notes = []
    conversationId.value = null
  }

  /** «Nueva»: empieza de cero en el mismo contexto. La anterior queda guardada (con login). */
  function newConversation(): void {
    reset()
  }

  /** Retoma una conversación guardada: sus turnos en pantalla y su historia para el modelo. */
  function resume(conversation: AssistantConversation): void {
    setScope(conversation.scope)
    setAgent(conversation.agent)
    parked.delete(keyOf(conversation.scope, conversation.agent))
    reset()
    conversationId.value = conversation.id
    for (const message of conversation.thread) {
      history.push({ role: message.role, content: message.content })
      if (message.role === 'user') {
        push({ kind: 'user', text: message.content })
        continue
      }
      push({ kind: 'assistant', text: message.content, activity: null, streaming: false })
      for (const proposal of message.proposals) push({ kind: 'proposal', proposal, status: 'past' })
      if (message.tasks.length) push({ kind: 'tasks', items: message.tasks })
    }
  }

  /** La conversación de cada contexto que se dejó, para volver a ella (mientras la página viva). */
  interface Parked {
    turns: Turn[]
    history: AssistantMessage[]
    notes: string[]
    conversationId: string | null
  }
  const parked = new Map<string, Parked>()
  const keyOf = (s: AssistantScope, a: string = agent.value) =>
    `${a}|${
      s.kind === 'general'
        ? 'general'
        : s.kind === 'project'
          ? `project:${s.project_id}`
          : `task:${s.ref}`
    }`

  /** Pasa a la conversación de `next` (contexto y agente): la que se deja queda aparcada y vuelve
   *  al volver a ella; una sin nada arranca de cero. */
  function switchTo(next: { scope: AssistantScope; agent: string }): void {
    if (turns.value.length) {
      parked.set(keyOf(scope.value), {
        turns: turns.value,
        history,
        notes,
        conversationId: conversationId.value,
      })
    }
    scope.value = next.scope
    agent.value = next.agent
    reset()
    const back = parked.get(keyOf(next.scope, next.agent))
    if (!back) return
    parked.delete(keyOf(next.scope, next.agent))
    turns.value = back.turns
    history = back.history
    notes = back.notes
    conversationId.value = back.conversationId
  }

  /** Cambia de contexto. Una conversación es de UN contexto. */
  function setScope(next: AssistantScope): void {
    scopeChosen = true
    if (sameScope(scope.value, next)) return
    switchTo({ scope: next, agent: agent.value })
  }

  /** Cambia de agente. Una conversación es de UN agente: en el mismo contexto, con otro agente,
   *  es otra conversación. */
  function setAgent(next: string): void {
    if (next === agent.value) return
    switchTo({ scope: scope.value, agent: next })
  }

  function push(turn: NewTurn): Turn {
    const full = { ...turn, id: nextId++ } as Turn
    turns.value = [...turns.value, full]
    return full
  }

  function patch(id: number, change: Partial<Turn>): void {
    turns.value = turns.value.map((t) => (t.id === id ? ({ ...t, ...change } as Turn) : t))
  }

  function messages(): AssistantMessage[] {
    const recent = history.slice(-HISTORY_CAP)
    const firstUser = recent.findIndex((m) => m.role === 'user')
    return firstUser <= 0 ? recent : recent.slice(firstUser)
  }

  /** Lo que un turno de respuesta fue acumulando mientras llegaba el stream. */
  interface Reply {
    id: number
    answer: string
    proposed: boolean
    failed: string | null
  }

  /** Los eventos que escriben en la conversación, no sólo en el turno que responde. */
  const CONVERSATION_EVENTS = new Set<AssistantStreamEvent['type']>([
    'proposal',
    'tasks',
    'conversation',
  ])

  function applyEvent(event: AssistantStreamEvent, reply: Reply, gen: number): void {
    if (event.type === 'proposal') reply.proposed = true
    // Un stream viejo (se cambió de contexto) ya no escribe en la conversación nueva.
    if (gen !== generation && CONVERSATION_EVENTS.has(event.type)) return
    switch (event.type) {
      case 'text':
        reply.answer += event.delta
        patch(reply.id, { text: reply.answer })
        break
      case 'tool':
        patch(reply.id, { activity: event.summary })
        break
      case 'proposal':
        push({ kind: 'proposal', proposal: event.proposal, status: 'open' })
        break
      case 'tasks':
        if (event.items.length) push({ kind: 'tasks', items: event.items })
        break
      case 'conversation':
        conversationId.value = event.id
        break
      case 'done':
        if (!reply.answer) reply.answer = event.text
        break
      case 'error':
        reply.failed = event.message
        break
    }
  }

  /** Cierra el turno: qué queda en el historial y en pantalla según cómo terminó. */
  function settle(reply: Reply): void {
    // Un turno sin texto (Stop antes de tiempo, o un error) no queda en el
    // historial: el próximo intento no debería arrastrar una pregunta huérfana.
    if (reply.answer) history.push({ role: 'assistant', content: reply.answer })
    else if (reply.proposed) history.push({ role: 'assistant', content: '(propuse una acción)' })
    else history.pop()
    if (!reply.answer) turns.value = turns.value.filter((t) => t.id !== reply.id)
    if (reply.failed) push({ kind: 'note', text: reply.failed })
  }

  /** Manda una pregunta y consume el stream de la respuesta. */
  async function send(text: string): Promise<void> {
    const question = text.trim()
    if (!question || streaming.value) return

    push({ kind: 'user', text: question })
    history.push({ role: 'user', content: [...notes, question].join('\n') })
    notes = []
    const turn = push({ kind: 'assistant', text: '', activity: null, streaming: true })
    const reply: Reply = { id: turn.id, answer: '', proposed: false, failed: null }
    streaming.value = true
    const gen = generation
    const controller = new AbortController()
    abort = controller

    try {
      // Renovado si está por vencer: con un token vencido el runner contesta igual, pero no guarda.
      const githubToken = await session.token()
      const events = streamAssistant(
        {
          scope: scope.value,
          messages: messages(),
          ...(agent.value !== DEFAULT_ASSISTANT_AGENT ? { agent: agent.value } : {}),
          // Sin login no se guarda: una conversación guardada no se sigue sin su dueño.
          ...(conversationId.value && githubToken ? { conversation_id: conversationId.value } : {}),
        },
        { signal: controller.signal, ...(githubToken ? { githubToken } : {}) },
      )
      for await (const event of events) applyEvent(event, reply, gen)
    } finally {
      streaming.value = false
      abort = null
      patch(reply.id, { text: reply.answer, activity: null, streaming: false })
    }

    // Cambió el contexto mientras respondía: esa conversación ya no existe.
    if (gen === generation) settle(reply)
  }

  /** Stop: corta el stream; lo que ya llegó se queda. */
  function stop(): void {
    abort?.abort()
  }

  /** «Ejecutar»: la acción se firma con el token de GitHub del usuario. */
  async function runProposal(id: number, githubToken: string): Promise<void> {
    const turn = turns.value.find((t) => t.id === id)
    if (turn?.kind !== 'proposal' || turn.status === 'running') return
    patch(id, { status: 'running', error: undefined } as Partial<Turn>)
    const proposal = turn.proposal
    try {
      const result = await execute(proposal, githubToken)
      if (result.ok) {
        const url = result.url
        patch(id, { status: 'done', message: result.message, url } as Partial<Turn>)
        notes.push(
          `[Nota: el usuario ejecutó "${proposal.label}" sobre ${proposalTarget(proposal)}${url ? ` → ${url}` : ''}]`,
        )
      } else {
        patch(id, { status: 'open', error: result.message } as Partial<Turn>)
      }
    } catch (err) {
      patch(id, {
        status: 'open',
        error: err instanceof Error ? err.message : String(err),
      } as Partial<Turn>)
    }
  }

  function dismissProposal(id: number): void {
    const turn = turns.value.find((t) => t.id === id)
    if (turn?.kind !== 'proposal' || turn.status !== 'open') return
    patch(id, { status: 'dismissed' } as Partial<Turn>)
    notes.push(
      `[Nota: el usuario descartó "${turn.proposal.label}" sobre ${proposalTarget(turn.proposal)}]`,
    )
  }

  return {
    scope,
    agent,
    agents,
    projects,
    tasks,
    turns,
    streaming,
    conversationId,
    suggestions,
    placeholder,
    loadProjects,
    setScope,
    setAgent,
    newConversation,
    resume,
    send,
    stop,
    runProposal,
    dismissProposal,
  }
})
