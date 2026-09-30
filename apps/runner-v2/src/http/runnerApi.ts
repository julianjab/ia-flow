/**
 * Las rutas de la web (`packages/shared/src/inbox.ts` es su contrato): la bandeja, el detalle de
 * una tarea, el "¿por qué?", la config, el stream de cambios, las acciones firmadas con el login de
 * GitHub de quien las hace, el device flow para ese login, y el asistente.
 */
import {
  AssistantRequestSchema,
  type AssistantStreamEvent,
  type ConfigSummary,
  DevicePollSchema,
  type RunnerInfo,
  type RunnerStreamEvent,
  TaskActionRequestSchema,
} from '@ia-flow/shared'
import { z } from 'zod'
import type { Assistant } from '../assistant/Assistant.js'
import { type DeviceFlow, githubLogin } from '../github/deviceFlow.js'
import type { InboxService } from '../inbox/InboxService.js'
import { TaskActionError, type TaskActions } from '../tasks/TaskActions.js'
import { ApiRouter, HttpError, sendJson } from './ApiRouter.js'
import { openSse, type SseHub, writeSse } from './sse.js'

export interface RunnerApiOptions {
  token: string | undefined
  version: string
  inbox: InboxService
  actions: TaskActions
  assistant: Assistant
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

  router.get('/api/runner', async (): Promise<RunnerInfo> => {
    const projects = (await inbox.inbox()).projects
    return {
      service: 'ia-flow-runner',
      version: options.version,
      projects,
      github_login: { device_flow: options.deviceFlow !== undefined },
      assistant: options.assistant.available,
    }
  })

  router.get('/api/inbox', (req) => inbox.inbox(req.query.get('project') ?? undefined))

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

  router.get('/api/explain', async (req) => {
    const ref = req.query.get('ref')
    if (!ref) throw new HttpError(400, 'falta ?ref=owner/repo#n')
    const result = await inbox.explain(ref, req.query.get('event') ?? undefined)
    if (!result) throw new HttpError(404, `${ref} no tiene eventos registrados`)
    return result
  })

  router.get('/api/config', async () => options.config())

  router.get('/api/stream', async (_req, res) => {
    hub.attach(res)
    return undefined
  })

  router.post('/api/assistant', async (req, res) => {
    const request = parseBody(AssistantRequestSchema, await req.json())
    openSse(res)
    const emit = (event: AssistantStreamEvent) => writeSse(res, event)
    await options.assistant.answer(request, emit)
    res.end()
    return undefined
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

  return router
}
