import type {
  AssistantConversation,
  AssistantMessage,
  AssistantProposal,
  AssistantScope,
  AssistantStreamEvent,
  InboxItem,
  InboxProject,
} from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { executeProposal, fetchProjects, streamAssistant } from '@/features/assistant/api'
import { useGithubSessionStore } from '@/stores/githubSession'

// La conversación del asistente. La página guarda los turnos y manda la
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
      error?: string
    }
  | { id: number; kind: 'tasks'; items: InboxItem[] }
  | { id: number; kind: 'note'; text: string }

/** Un turno sin su `id` (lo asigna el store); distribuye sobre la unión. */
type NewTurn = Turn extends infer T ? (T extends unknown ? Omit<T, 'id'> : never) : never

export interface ScopeChip {
  key: string
  label: string
  scope: AssistantScope
}

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

export function sameScope(a: AssistantScope, b: AssistantScope): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'project' && b.kind === 'project') return a.project_id === b.project_id
  if (a.kind === 'task' && b.kind === 'task') return a.ref === b.ref
  return true
}

export const useAssistantChatStore = defineStore('assistant-chat', () => {
  const scope = ref<AssistantScope>({ kind: 'general' })
  /** La última tarea sobre la que se preguntó: habilita el chip «Tarea». */
  const lastTaskRef = ref<string | null>(null)
  const projects = ref<InboxProject[]>([])
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

  const chips = computed<ScopeChip[]>(() => {
    const out: ScopeChip[] = [{ key: 'general', label: 'General', scope: { kind: 'general' } }]
    for (const p of projects.value) {
      out.push({
        key: `project:${p.id}`,
        label: projects.value.length > 1 ? p.id : 'Proyecto',
        scope: { kind: 'project', project_id: p.id },
      })
    }
    if (lastTaskRef.value) {
      out.push({
        key: `task:${lastTaskRef.value}`,
        label: lastTaskRef.value,
        scope: { kind: 'task', ref: lastTaskRef.value },
      })
    }
    return out
  })

  const suggestions = computed(() => SUGGESTIONS[scope.value.kind])

  const placeholder = computed(() => {
    const s = scope.value
    if (s.kind === 'general') return 'Preguntá sobre todo el runner…'
    return `Preguntá sobre ${s.kind === 'project' ? s.project_id : s.ref}…`
  })

  async function loadProjects(): Promise<void> {
    try {
      projects.value = await fetchProjects()
    } catch {
      projects.value = []
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

  /** Cambia de contexto. Una conversación es de UN contexto: cambiar la empieza de cero. */
  function setScope(next: AssistantScope): void {
    scopeChosen = true
    if (next.kind === 'task') lastTaskRef.value = next.ref
    if (sameScope(scope.value, next)) return
    scope.value = next
    reset()
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
      const github = session.github
      const events = streamAssistant(
        {
          scope: scope.value,
          messages: messages(),
          // Sin login no se guarda: una conversación guardada no se sigue sin su dueño.
          ...(conversationId.value && github ? { conversation_id: conversationId.value } : {}),
        },
        { signal: controller.signal, ...(github ? { githubToken: github.token } : {}) },
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
    try {
      const result = await executeProposal(turn.proposal, githubToken)
      if (result.ok) {
        patch(id, { status: 'done', message: result.message } as Partial<Turn>)
        notes.push(`[Nota: el usuario ejecutó "${turn.proposal.label}" sobre ${turn.proposal.ref}]`)
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
    notes.push(`[Nota: el usuario descartó "${turn.proposal.label}" sobre ${turn.proposal.ref}]`)
  }

  return {
    scope,
    lastTaskRef,
    projects,
    turns,
    streaming,
    conversationId,
    chips,
    suggestions,
    placeholder,
    loadProjects,
    setScope,
    newConversation,
    resume,
    send,
    stop,
    runProposal,
    dismissProposal,
  }
})
