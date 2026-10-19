import {
  type AddToBoardRequest,
  AddToBoardResultSchema,
  type AssistantAddToBoardProposal,
  type AssistantAgent,
  type AssistantConversation,
  AssistantConversationSchema,
  type AssistantConversationSummary,
  AssistantConversationSummarySchema,
  type AssistantIssueProposal,
  type AssistantLabelsProposal,
  type AssistantMoveProposal,
  type AssistantRequest,
  type AssistantScope,
  type AssistantStreamEvent,
  type AssistantTaskProposal,
  type CreateIssueRequest,
  type CreateIssueResult,
  CreateIssueResultSchema,
  type InboxItem,
  type InboxProject,
  InboxSchema,
  type MoveTaskRequest,
  RunnerInfoSchema,
  type TaskActionResult,
  TaskActionResultSchema,
  type TaskLabelsRequest,
} from '@ia-flow/shared'
import axios from 'axios'
import { serverTarget } from '@/composables/useServerTarget'
import { parseAssistantEvent, splitSse } from '@/features/assistant/sse'

/**
 * `POST /api/assistant` → los eventos del stream, en orden.
 *
 * `fetch` y no axios: una respuesta SSE se lee de a chunks con un reader, y un
 * `EventSource` no puede hacer POST. Como no pasa por el interceptor de axios,
 * el token del server se pone acá. La conversación completa viaja en cada
 * request; con `githubToken`, el runner además la guarda a nombre de ese login.
 *
 * Cualquier falla (HTTP, red, un stream que se corta sin `done`) sale como un
 * evento `error`, así quien consume tiene UN solo camino de error. Abortar con
 * `signal` termina el generador sin evento: es un Stop, no un error.
 */
export async function* streamAssistant(
  request: AssistantRequest,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; githubToken?: string } = {},
): AsyncGenerator<AssistantStreamEvent> {
  const target = serverTarget()
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(target.url('/api/assistant'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(target.token ? { 'x-ia-flow-token': target.token } : {}),
        ...(opts.githubToken ? { 'x-github-token': opts.githubToken } : {}),
      },
      body: JSON.stringify(request),
      signal: opts.signal,
    })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      yield { type: 'error', message: errorText(res.status, detail) }
      return
    }

    let finished = false
    for await (const event of readEvents(res.body)) {
      yield event
      if (event.type === 'done' || event.type === 'error') finished = true
    }
    if (!finished) yield { type: 'error', message: 'Se cortó la conexión con el asistente.' }
  } catch (err) {
    if (opts.signal?.aborted) return
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/** El body SSE → eventos válidos, reensamblando los que llegan partidos entre chunks. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AssistantStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const { events, rest } = splitSse(buffer)
    buffer = rest
    for (const data of events) {
      const event = parseAssistantEvent(data)
      if (event) yield event
    }
  }
}

function errorText(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string }
    const text = parsed.error ?? parsed.message
    if (text) return text
  } catch {
    /* no era JSON */
  }
  return `El runner respondió ${status}${body ? `: ${body.slice(0, 200)}` : ''}`
}

/** Las tareas de la bandeja, para elegir de qué hablar (`#`), y las columnas del board de cada
 *  proyecto (`/api/runner` no las trae): a qué columna se suma un issue propuesto. Se pide acá y no
 *  a la bandeja: la feature no depende de otra. */
export async function fetchTasks(): Promise<{
  items: InboxItem[]
  statuses: Record<string, string[]>
}> {
  const { data } = await axios.get<unknown>('/api/inbox')
  const inbox = InboxSchema.parse(data)
  const statuses: Record<string, string[]> = {}
  for (const project of inbox.projects) {
    if (project.statuses?.length) statuses[project.id] = project.statuses
  }
  return { items: inbox.items, statuses }
}

/** Los proyectos del runner (para los chips de contexto) y los agentes del asistente (para elegir
 *  con quién hablar). Se pide acá y no a la bandeja: la feature no depende de otra. */
export async function fetchRunner(): Promise<{
  projects: InboxProject[]
  agents: AssistantAgent[]
}> {
  const { data } = await axios.get<unknown>('/api/runner')
  const info = RunnerInfoSchema.parse(data)
  return { projects: info.projects, agents: info.assistant_agents }
}

const REF_RE = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/

/** `owner/repo#n` → `/api/tasks/owner/repo/n`; una ref inválida falla antes de la red. */
function taskPath(ref: string): string {
  const m = REF_RE.exec(ref)
  if (!m) throw new Error(`Referencia de tarea inválida: ${ref}`)
  const [, owner, repo, number] = m
  return `/api/tasks/${encodeURIComponent(owner as string)}/${encodeURIComponent(repo as string)}/${number}`
}

/**
 * Un POST firmado con el token de GitHub del USUARIO. Un rechazo del runner (4xx) vuelve con
 * `ok: false` y su mensaje; sólo un 5xx o una respuesta ilegible tiran.
 */
async function postSigned<T>(
  path: string,
  body: unknown,
  githubToken: string,
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  const res = await axios.post<unknown>(path, body, {
    headers: { 'x-github-token': githubToken },
    validateStatus: (s) => s < 500,
  })
  const parsed = schema.safeParse(res.data)
  if (parsed.success) return parsed.data
  throw new Error(`El runner respondió ${res.status} sin un resultado legible`)
}

/**
 * Ejecuta una acción propuesta, firmada con el token de GitHub del USUARIO.
 * Es el mismo endpoint que usa la bandeja (`features/inbox/api.ts`): son dos
 * features y no se importan entre sí, así que cada una trae su llamada.
 */
export async function executeProposal(
  proposal: Pick<AssistantTaskProposal, 'ref' | 'action' | 'comment' | 'pr'>,
  githubToken: string,
): Promise<TaskActionResult> {
  return postSigned(
    `${taskPath(proposal.ref)}/actions`,
    {
      action: proposal.action,
      ...(proposal.comment ? { comment: proposal.comment } : {}),
      ...(proposal.pr ? { pr: proposal.pr } : {}),
    },
    githubToken,
    TaskActionResultSchema,
  )
}

/** Mueve la card a la columna propuesta, con el login del usuario (como moverla en GitHub). */
export async function moveTask(
  proposal: Pick<AssistantMoveProposal, 'ref' | 'status'>,
  githubToken: string,
): Promise<TaskActionResult> {
  const body: MoveTaskRequest = { status: proposal.status }
  return postSigned(`${taskPath(proposal.ref)}/status`, body, githubToken, TaskActionResultSchema)
}

/** Suma al board el issue propuesto, con el login del usuario. */
export async function addToBoard(
  proposal: Pick<AssistantAddToBoardProposal, 'issue' | 'status' | 'project_id'>,
  githubToken: string,
): Promise<TaskActionResult> {
  const body: AddToBoardRequest = {
    issue: proposal.issue,
    ...(proposal.status ? { status: proposal.status } : {}),
    ...(proposal.project_id ? { project_id: proposal.project_id } : {}),
  }
  return postSigned('/api/board/items', body, githubToken, AddToBoardResultSchema)
}

/** Pone y saca los labels propuestos del issue de la tarea, con el login del usuario. */
export async function changeLabels(
  proposal: Pick<AssistantLabelsProposal, 'ref' | 'add' | 'remove'>,
  githubToken: string,
): Promise<TaskActionResult> {
  const body: TaskLabelsRequest = {
    ...(proposal.add?.length ? { add: proposal.add } : {}),
    ...(proposal.remove?.length ? { remove: proposal.remove } : {}),
  }
  return postSigned(`${taskPath(proposal.ref)}/labels`, body, githubToken, TaskActionResultSchema)
}

/**
 * Abre un issue que propuso el asistente, con el token de GitHub del USUARIO: queda a su nombre.
 * Con `board`, el runner además lo suma al board de ese proyecto en `status` (la columna que eligió
 * la persona; sin ella, Todo). Si sumarlo falla el issue queda abierto igual (`board_error`).
 */
export async function createIssue(
  proposal: Pick<AssistantIssueProposal, 'repo' | 'title' | 'body' | 'labels' | 'board'>,
  githubToken: string,
): Promise<CreateIssueResult> {
  const { board } = proposal
  const body: CreateIssueRequest = {
    repo: proposal.repo,
    title: proposal.title,
    body: proposal.body,
    ...(proposal.labels?.length ? { labels: proposal.labels } : {}),
    ...(board
      ? {
          board: {
            project_id: board.project_id,
            ...(board.status ? { status: board.status } : {}),
          },
        }
      : {}),
  }
  return postSigned('/api/issues', body, githubToken, CreateIssueResultSchema)
}

// ── conversaciones guardadas: siempre del login de GitHub que las pide ─────

const asUser = (githubToken: string) => ({ headers: { 'x-github-token': githubToken } })

/** Las conversaciones guardadas de este login en un contexto, de la más reciente a la más vieja. */
/** Las conversaciones guardadas de este login —de un contexto, o de todos—, la más reciente primero. */
export async function listConversations(
  scope: AssistantScope | null,
  githubToken: string,
): Promise<AssistantConversationSummary[]> {
  const { data } = await axios.get<unknown>('/api/assistant/conversations', {
    ...asUser(githubToken),
    ...(scope ? { params: { scope: JSON.stringify(scope) } } : {}),
  })
  return AssistantConversationSummarySchema.array().parse(data)
}

export async function getConversation(
  id: string,
  githubToken: string,
): Promise<AssistantConversation> {
  const { data } = await axios.get<unknown>(
    `/api/assistant/conversations/${encodeURIComponent(id)}`,
    asUser(githubToken),
  )
  return AssistantConversationSchema.parse(data)
}

export async function deleteConversation(id: string, githubToken: string): Promise<void> {
  await axios.delete(`/api/assistant/conversations/${encodeURIComponent(id)}`, asUser(githubToken))
}
