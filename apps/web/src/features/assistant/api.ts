import {
  type AssistantConversation,
  AssistantConversationSchema,
  type AssistantConversationSummary,
  AssistantConversationSummarySchema,
  type AssistantProposal,
  type AssistantRequest,
  type AssistantScope,
  type AssistantStreamEvent,
  type InboxItem,
  type InboxProject,
  InboxSchema,
  RunnerInfoSchema,
  type TaskActionResult,
  TaskActionResultSchema,
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

/** Los proyectos del runner, para los chips de contexto. Se pide acá y no a la bandeja: la feature no depende de otra. */
/** Las tareas de la bandeja, para elegir de qué hablar (`#`). Se pide acá y no a la bandeja: la
 *  feature no depende de otra. */
export async function fetchTasks(): Promise<InboxItem[]> {
  const { data } = await axios.get<unknown>('/api/inbox')
  return InboxSchema.parse(data).items
}

export async function fetchProjects(): Promise<InboxProject[]> {
  const { data } = await axios.get<unknown>('/api/runner')
  return RunnerInfoSchema.parse(data).projects
}

const REF_RE = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/

/**
 * Ejecuta una acción propuesta, firmada con el token de GitHub del USUARIO.
 * Es el mismo endpoint que usa la bandeja (`features/inbox/api.ts`): son dos
 * features y no se importan entre sí, así que cada una trae su llamada.
 */
export async function executeProposal(
  proposal: Pick<AssistantProposal, 'ref' | 'action' | 'comment'>,
  githubToken: string,
): Promise<TaskActionResult> {
  const m = REF_RE.exec(proposal.ref)
  if (!m) throw new Error(`Referencia de tarea inválida: ${proposal.ref}`)
  const [, owner, repo, number] = m
  const res = await axios.post<unknown>(
    `/api/tasks/${encodeURIComponent(owner as string)}/${encodeURIComponent(repo as string)}/${number}/actions`,
    { action: proposal.action, ...(proposal.comment ? { comment: proposal.comment } : {}) },
    { headers: { 'x-github-token': githubToken }, validateStatus: (s) => s < 500 },
  )
  const parsed = TaskActionResultSchema.safeParse(res.data)
  if (parsed.success) return parsed.data
  throw new Error(`El runner respondió ${res.status} sin un resultado legible`)
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
