/**
 * Las rutas de la web (`packages/shared/src/inbox.ts` es su contrato): la bandeja, el detalle de
 * una tarea, el "¿por qué?", la config, el stream de cambios, las acciones firmadas con el login de
 * GitHub de quien las hace, el device flow para ese login, y el asistente.
 */

import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import {
  type AssistantConversation,
  type AssistantConversationSummary,
  AssistantRequestSchema,
  AssistantScopeSchema,
  type AssistantStreamEvent,
  type ConfigSummary,
  type CreateIssueRequest,
  CreateIssueRequestSchema,
  type CreateIssueResult,
  DevicePollSchema,
  GithubRefreshRequestSchema,
  type GithubUserToken,
  GithubUserTokenSchema,
  type InboxProject,
  type RunnerInfo,
  type RunnerStreamEvent,
  TaskActionRequestSchema,
} from '@ia-flow/shared'
import { z } from 'zod'
import type { Assistant } from '../assistant/Assistant.js'
import type { ConversationStore } from '../assistant/ConversationStore.js'
import { type DeviceFlow, githubLogin, RefreshRejectedError } from '../github/deviceFlow.js'
import { ApiRouter, HttpError, sendJson } from '../http/ApiRouter.js'
import { openSse, type SseHub, writeSse } from '../http/sse.js'
import type { InboxService } from './InboxService.js'
import type { IngressService } from './IngressService.js'
import { TaskActionError, type TaskActions } from './TaskActions.js'

export interface RunnerApiOptions {
  token: string | undefined
  version: string
  /** Los proyectos y su board, de la config. */
  projects: InboxProject[]
  inbox: InboxService
  actions: TaskActions
  assistant: Assistant
  /** Las entradas del runner (webhook de GitHub, Slack) y lo que les llegó. */
  ingress?: IngressService
  /** Las conversaciones guardadas del asistente, de cada login. Sin esto, no hay historial. */
  conversations?: ConversationStore
  /** Sin `github.clientId` no hay login desde la web. */
  deviceFlow?: DeviceFlow
  config: () => ConfigSummary
  hub: SseHub<RunnerStreamEvent>
  log: (line: string) => void
  fetchImpl?: typeof fetch
}

const DevicePollRequest = z.object({ device_code: z.string().min(1) })

/** Cuánto se confía en el login de un token de GitHub antes de volver a preguntar. */
const LOGIN_TTL_MS = 5 * 60_000

function refOf(params: Record<string, string>): string {
  return `${params.owner}/${params.repo}#${params.number}`
}

/** Un body que no cumple el contrato: 400 con qué falló. */
function parseBody<T>(
  schema: { safeParse(input: unknown): { success: boolean; data?: T; error?: unknown } },
  input: unknown,
): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new HttpError(400, `body inválido: ${String(parsed.error)}`)
  return parsed.data as T
}

/** GitHub no abrió el issue: el status y el mensaje que dio, para la web. */
class IssueRejectedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function createIssue(
  request: CreateIssueRequest,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<{ number: number; html_url: string }> {
  const client = new GithubClient({
    auth: new GithubTokenAuth(token),
    ...(fetchImpl ? { fetchImpl } : {}),
  })
  const res = await client.request(`/repos/${request.repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: request.title,
      body: request.body,
      ...(request.labels?.length ? { labels: request.labels } : {}),
    }),
  })
  if (!res.ok) {
    const detail = ((await res.json().catch(() => ({}))) as { message?: string }).message
    // 404/403: el repo no existe para esa cuenta o no puede abrir issues en él.
    const status = res.status === 404 || res.status === 403 ? 403 : 502
    throw new IssueRejectedError(
      status,
      `GitHub no abrió el issue en ${request.repo} (${res.status}${detail ? `: ${detail}` : ''})`,
    )
  }
  return (await res.json()) as { number: number; html_url: string }
}

export function runnerApi(options: RunnerApiOptions): ApiRouter {
  const { inbox, hub } = options
  const router = new ApiRouter({ token: options.token, log: options.log })
  /** El login de cada token de GitHub ya visto, por un rato: no preguntarle a GitHub en cada
   *  acción, pero que un token revocado deje de servir sin reiniciar el runner. */
  const logins = new Map<string, { login: Promise<string>; at: number }>()
  const loginOf = (token: string) => {
    const cached = logins.get(token)
    if (cached && Date.now() - cached.at < LOGIN_TTL_MS) return cached.login
    const login = githubLogin(token, options.fetchImpl).catch((err: unknown) => {
      logins.delete(token)
      throw new HttpError(401, (err as Error).message)
    })
    logins.set(token, { login, at: Date.now() })
    return login
  }

  // Contesta al toque, sin leer el board: es lo que la web consulta para reconocer al runner.
  router.get('/api/runner', async (): Promise<RunnerInfo> => {
    return {
      service: 'ia-flow-runner',
      version: options.version,
      projects: options.projects,
      github_login: { device_flow: options.deviceFlow !== undefined },
      assistant: options.assistant.available,
      assistant_agents: options.assistant.available ? options.assistant.agents() : [],
    }
  })

  router.get('/api/inbox', (req) => inbox.inbox(req.query.get('project') ?? undefined))

  // Los hechos de cada tarea, sin clasificar: qué es una decisión lo dice el dashboard de quien mira.
  router.get('/api/tasks', (req) => inbox.tasks(req.query.get('project') ?? undefined))

  // Lo que la bandeja no muestra: se pide aparte (la web, sólo al abrir esa sección).
  router.get('/api/board', (req) => inbox.rest(req.query.get('project') ?? undefined))

  router.get('/api/tasks/:owner/:repo/:number', async (req) => {
    const detail = await inbox.detail(refOf(req.params), req.query.get('execution') ?? undefined)
    if (!detail)
      throw new HttpError(404, `${refOf(req.params)} no está en ningún board de este runner`)
    return detail
  })

  // Un rechazo responde con la forma del contrato (`TaskActionResult`, `ok: false`) y su status:
  // la web muestra el mensaje tal cual.
  router.post('/api/tasks/:owner/:repo/:number/actions', async (req, res) => {
    const reject = (status: number, message: string) => {
      sendJson(res, status, { ok: false, message })
      return undefined
    }
    const token = req.header('x-github-token')
    if (!token) return reject(401, 'Iniciá sesión con GitHub para mover tareas')
    try {
      const request = parseBody(TaskActionRequestSchema, await req.json())
      const login = await loginOf(token)
      return await options.actions.run(refOf(req.params), request, { token, login })
    } catch (err) {
      if (err instanceof TaskActionError || err instanceof HttpError) {
        return reject(err.status, err.message)
      }
      throw err
    }
  })

  // Un issue que propuso el asistente (`assistant_propose_issue`), con el token de quien lo
  // confirma: lo abre esa persona, en un repo donde ella puede abrirlo. El runner no pone nada suyo.
  router.post('/api/issues', async (req, res) => {
    const reject = (status: number, message: string) => {
      sendJson(res, status, { ok: false, message } satisfies CreateIssueResult)
      return undefined
    }
    const token = req.header('x-github-token')
    if (!token) return reject(401, 'Iniciá sesión con GitHub para abrir el issue')
    try {
      const request = parseBody(CreateIssueRequestSchema, await req.json())
      const login = await loginOf(token)
      const created = await createIssue(request, token, options.fetchImpl)
      options.log(`${login}: abrió ${request.repo}#${created.number} desde el asistente`)
      return {
        ok: true,
        message: `${request.repo}#${created.number} abierto`,
        url: created.html_url,
        number: created.number,
        github_login: login,
      } satisfies CreateIssueResult
    } catch (err) {
      if (err instanceof HttpError) return reject(err.status, err.message)
      if (err instanceof IssueRejectedError) return reject(err.status, err.message)
      throw err
    }
  })

  router.get('/api/explain', async (req) => {
    const ref = req.query.get('ref')
    if (!ref) throw new HttpError(400, 'falta ?ref=owner/repo#n')
    const result = await inbox.explain(ref, req.query.get('event') ?? undefined)
    if (!result) throw new HttpError(404, `${ref} no tiene eventos registrados`)
    return result
  })

  router.get('/api/config', async () => options.config())

  router.get('/api/ingress', async () => {
    if (!options.ingress) throw new HttpError(501, 'Este runner no expone sus entradas')
    return options.ingress.ingress()
  })

  router.get('/api/ingress/:id/events', async (req) => {
    if (!options.ingress) throw new HttpError(501, 'Este runner no expone sus entradas')
    const events = options.ingress.events(
      req.params.id as string,
      Number(req.query.get('limit')) || 50,
    )
    if (!events) throw new HttpError(404, `${req.params.id} no es una entrada de este runner`)
    return events
  })

  router.get('/api/stream', async (_req, res) => {
    hub.attach(res)
    return undefined
  })

  // Con `x-github-token`, el intercambio se guarda a nombre de ese login; sin él —o con un token
  // que ya no sirve— contesta igual y no guarda nada. Seguir una conversación que no es de ese
  // login (otra sesión, borrada, vencida) abre una nueva: la ajena nunca se lee ni se toca.
  router.post('/api/assistant', async (req, res) => {
    const request = parseBody(AssistantRequestSchema, await req.json())
    const token = req.header('x-github-token')
    const login = token ? await loginOf(token).catch(() => undefined) : undefined
    openSse(res)
    const emit = (event: AssistantStreamEvent) => writeSse(res, event)
    await options.assistant.answer(request, emit, login ? { login } : {})
    res.end()
    return undefined
  })

  /** El login de quien pide su historial: sin él no hay historial. */
  const historyOwner = async (header: string | undefined) => {
    if (!options.conversations) throw new HttpError(501, 'Este runner no guarda conversaciones')
    if (!header) throw new HttpError(401, 'Iniciá sesión con GitHub para ver tus conversaciones')
    return { store: options.conversations, login: await loginOf(header) }
  }

  // `?scope=` es un AssistantScope en JSON: sólo las de ese contexto.
  router.get(
    '/api/assistant/conversations',
    async (req): Promise<AssistantConversationSummary[]> => {
      const { store, login } = await historyOwner(req.header('x-github-token'))
      const raw = req.query.get('scope')
      let scope: unknown
      try {
        scope = raw ? JSON.parse(raw) : undefined
      } catch {
        throw new HttpError(400, '?scope= no es JSON')
      }
      return store.list(
        login,
        scope === undefined ? undefined : parseBody(AssistantScopeSchema, scope),
      )
    },
  )

  router.get('/api/assistant/conversations/:id', async (req): Promise<AssistantConversation> => {
    const { store, login } = await historyOwner(req.header('x-github-token'))
    const conversation = store.get(req.params.id as string, login)
    if (!conversation) throw new HttpError(404, 'Esa conversación no existe o no es tuya')
    // Las tareas, como están ahora en la bandeja; una que ya no está en ningún board se omite.
    const thread = await Promise.all(
      conversation.thread.map(async (message) => ({
        ...message,
        tasks: (await Promise.all(message.tasks.map((ref) => inbox.item(ref)))).filter(
          (item) => item !== undefined,
        ),
      })),
    )
    return { ...conversation, thread }
  })

  router.delete('/api/assistant/conversations/:id', async (req) => {
    const { store, login } = await historyOwner(req.header('x-github-token'))
    if (!store.remove(req.params.id as string, login)) {
      throw new HttpError(404, 'Esa conversación no existe o no es tuya')
    }
    return { ok: true }
  })

  router.post('/api/auth/github/device', async () => {
    if (!options.deviceFlow) {
      throw new HttpError(
        501,
        'El login con GitHub no está configurado (github.clientId en runner.yaml)',
      )
    }
    return options.deviceFlow.start()
  })

  router.post('/api/auth/github/device/poll', async (req) => {
    if (!options.deviceFlow) throw new HttpError(501, 'El login con GitHub no está configurado')
    const { device_code } = parseBody(DevicePollRequest, await req.json())
    return DevicePollSchema.parse(await options.deviceFlow.poll(device_code))
  })

  // La web renueva su token antes de que venza (8 h): un `refresh_token` que GitHub ya no acepta
  // es un 401 —hay que volver a loguearse—, no un error del runner.
  router.post('/api/auth/github/refresh', async (req): Promise<GithubUserToken> => {
    if (!options.deviceFlow) throw new HttpError(501, 'El login con GitHub no está configurado')
    const { refresh_token } = parseBody(GithubRefreshRequestSchema, await req.json())
    try {
      return GithubUserTokenSchema.parse(await options.deviceFlow.refresh(refresh_token))
    } catch (err) {
      if (err instanceof RefreshRejectedError) throw new HttpError(401, err.message)
      throw err
    }
  })

  return router
}
