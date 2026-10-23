import {
  type Ingress,
  IngressSchema,
  type RunnerInfo,
  RunnerInfoSchema,
  type RunnerLogs,
  RunnerLogsSchema,
  type RunnerResources,
  RunnerResourcesSchema,
} from '@ia-flow/shared'
import axios from 'axios'
import { z } from 'zod'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import type { HealthSnapshot, WebhookStatus } from '@/features/runner-health/status'

// El estado del runner, con lo que ya expone: `/health`, `/api/runner`, `/api/webhooks/status`,
// `/api/ingress`, `/api/resources` y `/api/logs`. Un runner anterior a alguno contesta 404 (o 501
// si no lo tiene configurado): esa parte vuelve `null` y la pantalla no la dibuja (R13).

const HealthSchema = z.object({ ok: z.boolean() })

/** Lo que se mira de `/api/webhooks/status` (no hay schema compartido: es del server del webhook). */
const WebhookStatusSchema = z.object({
  secretConfigured: z.boolean().optional(),
  executions: z.object({ running: z.number(), waiting: z.number(), paused: z.number() }).optional(),
})

function isMissing(err: unknown): boolean {
  const status = axios.isAxiosError(err) ? err.response?.status : undefined
  return status === 404 || status === 501
}

/** El pedido, o `null` si el runner no tiene ese endpoint. */
async function optional<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load()
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
}

/**
 * ¿Responde? `GET /health` (la probe de k8s). Detrás del proxy de la web `/health` no llega al runner
 * (vuelve la página o un 404): ahí la prueba es `/api/runner`. Lanza si no responde.
 */
export async function probe(): Promise<void> {
  try {
    const { data } = await axios.get<unknown>('/health')
    const parsed = HealthSchema.safeParse(data)
    if (parsed.success) {
      if (!parsed.data.ok) throw new Error('/health contestó que no está bien')
      return
    }
  } catch (err) {
    if (!isMissing(err)) throw err
  }
  await axios.get<unknown>('/api/runner')
}

export async function getRunnerInfo(): Promise<RunnerInfo | null> {
  return optional(async () =>
    RunnerInfoSchema.parse((await axios.get<unknown>('/api/runner')).data),
  )
}

export async function getWebhookStatus(): Promise<WebhookStatus | null> {
  return optional(async () =>
    WebhookStatusSchema.parse((await axios.get<unknown>('/api/webhooks/status')).data),
  )
}

export async function getIngress(): Promise<Ingress | null> {
  return optional(async () => IngressSchema.parse((await axios.get<unknown>('/api/ingress')).data))
}

export async function getResources(): Promise<RunnerResources | null> {
  return optional(async () =>
    RunnerResourcesSchema.parse((await axios.get<unknown>('/api/resources')).data),
  )
}

export interface LogsQuery {
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** Sólo las líneas con `seq` mayor. */
  after?: number
  limit?: number
}

/** `GET /api/logs`; `null` si el runner no lo expone. */
export async function getLogs(query: LogsQuery = {}): Promise<RunnerLogs | null> {
  const params = {
    ...(query.level ? { level: query.level } : {}),
    ...(query.after ? { after: query.after } : {}),
    ...(query.limit ? { limit: query.limit } : {}),
  }
  return optional(async () =>
    RunnerLogsSchema.parse((await axios.get<unknown>('/api/logs', { params })).data),
  )
}

/** Si falla, `undefined`: esa parte no se sabe esta vez, y no tapa al resto. */
async function settle<T>(load: Promise<T>): Promise<T | undefined> {
  try {
    return await load
  } catch {
    return undefined
  }
}

/** Todo junto, en paralelo. Sólo la probe decide si responde; cada parte que falle queda vacía. */
export async function checkHealth(): Promise<HealthSnapshot> {
  const started = performance.now()
  try {
    await probe()
  } catch (err) {
    return { checkedAt: Date.now(), alive: false, failure: extractErrorMessage(err) }
  }
  const latencyMs = Math.round(performance.now() - started)
  const [info, webhooks, ingress, resources, logs] = await Promise.all([
    settle(getRunnerInfo()),
    settle(getWebhookStatus()),
    settle(getIngress()),
    settle(getResources()),
    settle(getLogs({ level: 'warn', limit: 8 })),
  ])
  return {
    checkedAt: Date.now(),
    alive: true,
    latencyMs,
    info,
    webhooks,
    ingress,
    resources,
    problems: logs === undefined ? undefined : (logs?.lines ?? null),
  }
}
