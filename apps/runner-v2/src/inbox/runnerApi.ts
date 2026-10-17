/**
 * Las rutas de la web (`packages/shared/src/inbox.ts` es su contrato): la bandeja, el detalle de
 * una tarea, el "¿por qué?", la config, el stream de cambios, las acciones firmadas con el login de
 * GitHub de quien las hace, el device flow para ese login, el asistente, y las mejoras que
 * propuso un agente esperando a una persona.
 */

import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import {
  AddToBoardRequestSchema,
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
  type ImprovementDecisionResult,
  type ImprovementList,
  ImprovementOpenRequestSchema,
  type ImprovementProposal,
  ImprovementStatusSchema,
  type InboxProject,
  MoveTaskRequestSchema,
  type RunnerInfo,
  type RunnerResources,
  type RunnerStreamEvent,
  TaskActionRequestSchema,
  TaskLabelsRequestSchema,
} from '@ia-flow/shared'
import { parseLogLevel } from '@ia-flow/telemetry'
import { z } from 'zod'
import type { Assistant } from '../assistant/Assistant.js'
import type { ConversationStore } from '../assistant/ConversationStore.js'
import type { ImprovementStore } from '../assistant/ImprovementStore.js'
import { type DeviceFlow, githubLogin, RefreshRejectedError } from '../github/deviceFlow.js'
import { type ApiRequest, ApiRouter, HttpError, sendJson } from '../http/ApiRouter.js'
import { openSse, type SseHub, writeSse } from '../http/sse.js'
import type { BoardMoves } from './BoardMoves.js'
import type { InboxService } from './InboxService.js'
import type { IngressService } from './IngressService.js'
import { type IssueBoard, placement } from './issueBoards.js'
import type { RunnerLogs } from './RunnerLogs.js'
import { TaskActionError, type TaskActions } from './TaskActions.js'

export interface RunnerApiOptions {
  token: string | undefined
  version: string
  /** Los proyectos y su board, de la config. */
  projects: InboxProject[]
  inbox: InboxService
  actions: TaskActions
  /** Sumar un issue al board, mover una card de columna y cambiarle labels. Sin esto, 501. */
  moves?: BoardMoves
  assistant: Assistant
  /** Las entradas del runner (webhook de GitHub, Slack) y lo que les llegó. */
  ingress?: IngressService
  /** Las últimas líneas del log del proceso (`GET /api/logs`). Sin esto, 501. */
  logs?: RunnerLogs
  /** La memoria, el disco y los worktrees del runner y de sus hosts (`GET /api/resources`). Sin
   *  esto, 501. */
  resources?: () => RunnerResources
  /** Las conversaciones guardadas del asistente, de cada login. Sin esto, no hay historial. */
  conversations?: ConversationStore
  /** Las mejoras propuestas por un agente (la retrospectiva). Sin esto, no hay. */
  improvements?: ImprovementStore
  /** A qué board entra el issue de una mejora y en qué columnas (`issueBoards.ts`). Sin esto, se
   *  abre sin columna. */
  issueBoard?: (repo: string) => Promise<IssueBoard | undefined>
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

/** Para el log: de qué tarea sale una mejora (una de config o del engine puede no salir de ninguna). */
function improvementOrigin(proposal: ImprovementProposal): string {
  return proposal.task_ref ? `mejora de ${proposal.task_ref}` : 'mejora sin tarea'
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

/** Lo que se contesta al abrir un issue, según cómo le fue al sumarlo al board (si se pidió). */
function openedResult(
  ref: string,
  board: { status?: string; error?: string },
): Pick<CreateIssueResult, 'ok' | 'message' | 'board_status' | 'board_error'> {
  if (board.error) {
    return {
      ok: true,
      message: `${ref} abierto, pero no quedó en el board: ${board.error}`,
      board_error: board.error,
    }
  }
  if (board.status) {
    return { ok: true, message: `${ref} abierto y en ${board.status}`, board_status: board.status }
  }
  return { ok: true, message: `${ref} abierto` }
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

  // Lo que una persona hace con una tarea o el board, firmado con su login de GitHub. Un rechazo
  // responde con la forma del contrato (`TaskActionResult`, `ok: false`) y su status: la web
  // muestra el mensaje tal cual.
  const signedPost = <T>(
    path: string,
    schema: Parameters<typeof parseBody<T>>[0],
    loginFirst: string,
    run: (body: T, req: ApiRequest, actor: { token: string; login: string }) => Promise<unknown>,
  ) =>
    router.post(path, async (req, res) => {
      const reject = (status: number, message: string) => {
        sendJson(res, status, { ok: false, message })
        return undefined
      }
      const token = req.header('x-github-token')
      if (!token) return reject(401, `Iniciá sesión con GitHub para ${loginFirst}`)
      try {
        const body = parseBody(schema, await req.json())
        const login = await loginOf(token)
        return await run(body, req, { token, login })
      } catch (err) {
        if (err instanceof TaskActionError || err instanceof HttpError) {
          return reject(err.status, err.message)
        }
        throw err
      }
    })

  signedPost(
    '/api/tasks/:owner/:repo/:number/actions',
    TaskActionRequestSchema,
    'mover tareas',
    (request, req, actor) => options.actions.run(refOf(req.params), request, actor),
  )

  const boardMoves = () => {
    if (!options.moves) throw new HttpError(501, 'Este runner no mueve cards del board')
    return options.moves
  }

  // Mover la card a otra columna, con el login de quien la mueve: como moverla en GitHub.
  signedPost(
    '/api/tasks/:owner/:repo/:number/status',
    MoveTaskRequestSchema,
    'mover tareas',
    ({ status }, req, actor) => boardMoves().move(refOf(req.params), status, actor),
  )

  // Poner y sacar labels del issue de la card, con el login de quien lo pide.
  signedPost(
    '/api/tasks/:owner/:repo/:number/labels',
    TaskLabelsRequestSchema,
    'cambiar labels',
    (request, req, actor) => boardMoves().labels(refOf(req.params), request, actor),
  )

  // Un issue que no está en el board pasa a estarlo, a nombre de quien lo agrega.
  signedPost(
    '/api/board/items',
    AddToBoardRequestSchema,
    'agregar al board',
    (request, _req, actor) => boardMoves().add(request, actor),
  )

  // Un issue que propuso el asistente (`assistant_propose_issue`), con el token de quien lo
  // confirma: lo abre esa persona, en un repo donde ella puede abrirlo. El runner no pone nada suyo.
  /** Un issue recién abierto, al board: si no se puede, el issue queda igual (ya existe) y se dice
   *  por qué, en vez de fallar el pedido entero. */
  const addCreated = async (
    ref: string,
    board: NonNullable<CreateIssueRequest['board']>,
    actor: { token: string; login: string },
  ): Promise<{ status?: string; error?: string }> => {
    if (!options.moves) return { error: 'este runner no suma issues al board' }
    try {
      const added = await options.moves.add({ ...board, issue: ref }, actor)
      return { status: added.status ?? '' }
    } catch (err) {
      // El issue ya existe: un 500 haría que la persona lo reintente y lo duplique.
      if (!(err instanceof TaskActionError)) options.log(`${ref}: no se sumó al board: ${err}`)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

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
      const ref = `${request.repo}#${created.number}`
      options.log(`${login}: abrió ${ref} desde el asistente`)
      const board = request.board ? await addCreated(ref, request.board, { token, login }) : {}
      return {
        ...openedResult(ref, board),
        url: created.html_url,
        number: created.number,
        github_login: login,
      }
    } catch (err) {
      if (err instanceof HttpError) return reject(err.status, err.message)
      if (err instanceof IssueRejectedError) return reject(err.status, err.message)
      throw err
    }
  })

  const improvementsStore = () => {
    if (!options.improvements) throw new HttpError(501, 'Este runner no guarda mejoras propuestas')
    return options.improvements
  }

  // Las mejoras que propuso un agente: `?status=open` (default), `opened`, `dismissed` o `all`.
  router.get('/api/improvements', async (req): Promise<ImprovementList> => {
    const raw = req.query.get('status') ?? 'open'
    const status = raw === 'all' ? undefined : parseBody(ImprovementStatusSchema, raw)
    const items = improvementsStore().list(status)
    // Las columnas, sólo de las que esperan decisión, y un board por repo.
    const boards = new Map<string, Promise<IssueBoard | undefined>>()
    const boardOf = (repo: string) => {
      if (!boards.has(repo))
        boards.set(repo, options.issueBoard?.(repo) ?? Promise.resolve(undefined))
      return boards.get(repo) as Promise<IssueBoard | undefined>
    }
    return {
      items: await Promise.all(
        items.map(async (item) => {
          const columns = item.status === 'open' ? (await boardOf(item.repo))?.columns : undefined
          return columns?.length ? { ...item, columns } : item
        }),
      ),
    }
  })

  // Abrir una es crear su issue con el token de quien la confirma (como `POST /api/issues`);
  // descartarla también queda a su nombre. Una ya decidida no se vuelve a decidir: 409.
  router.post('/api/improvements/:id/:decision', async (req, res) => {
    const reject = (status: number, message: string) => {
      sendJson(res, status, { ok: false, message } satisfies ImprovementDecisionResult)
      return undefined
    }
    const decision = req.params.decision
    if (decision !== 'open' && decision !== 'dismiss') {
      return reject(404, `${decision} no es una decisión: open o dismiss`)
    }
    const token = req.header('x-github-token')
    if (!token) return reject(401, 'Iniciá sesión con GitHub para decidir la mejora')
    const store = improvementsStore()
    const proposal = store.get(req.params.id as string)
    if (!proposal) return reject(404, 'Esa mejora no existe')
    if (proposal.status !== 'open') return reject(409, `Esa mejora ya está ${proposal.status}`)
    try {
      const login = await loginOf(token)
      if (decision === 'dismiss') {
        const decided = store.decide(proposal.id, { status: 'dismissed', by: login })
        if (!decided) return reject(409, 'Esa mejora ya fue decidida')
        return {
          ok: true,
          message: 'Descartada',
          proposal: decided,
        } satisfies ImprovementDecisionResult
      }
      const { repo, title, body } = proposal
      const { status } = parseBody(ImprovementOpenRequestSchema, await req.json())
      // La columna se valida antes de abrir nada: elegida mal, no queda un issue suelto.
      const board = await options.issueBoard?.(repo)
      let placed: ReturnType<typeof placement> = {}
      try {
        placed = board ? placement(board, status) : {}
      } catch (err) {
        return reject(400, err instanceof Error ? err.message : String(err))
      }
      const labels = [...(proposal.labels ?? []), ...(placed.label ? [placed.label] : [])]
      const created = await createIssue(
        { repo, title, body, ...(labels.length ? { labels } : {}) },
        token,
        options.fetchImpl,
      )
      const decided = store.decide(proposal.id, {
        status: 'opened',
        by: login,
        issue_url: created.html_url,
      })
      const ref = `${repo}#${created.number}`
      options.log(`${login}: abrió ${ref} (${improvementOrigin(proposal)})`)
      // En un repo de un proyecto del runner, el issue entra a su board; en uno por labels, ya
      // entró con el label de su columna. Desde ahí su pipeline lo refina e implementa.
      const entered =
        board?.kind === 'project'
          ? await addCreated(
              ref,
              { project_id: board.project_id, ...(placed.status ? { status: placed.status } : {}) },
              { token, login },
            )
          : { ...(placed.status ? { status: placed.status } : {}) }
      return {
        ok: true,
        message: openedResult(ref, entered).message,
        ...(decided ? { proposal: decided } : {}),
      } satisfies ImprovementDecisionResult
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

  router.get('/api/logs', async (req) => {
    if (!options.logs) throw new HttpError(501, 'Este runner no expone su log')
    const level = parseLogLevel(req.query.get('level') ?? undefined)
    const after = Number(req.query.get('after'))
    const limit = Number(req.query.get('limit'))
    return options.logs.page({
      ...(Number.isFinite(after) && after > 0 ? { after } : {}),
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      ...(level ? { level } : {}),
      ...(req.query.get('q') ? { text: req.query.get('q') as string } : {}),
    })
  })

  router.get('/api/resources', async (): Promise<RunnerResources> => {
    if (!options.resources) throw new HttpError(501, 'Este runner no expone sus recursos')
    return options.resources()
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
