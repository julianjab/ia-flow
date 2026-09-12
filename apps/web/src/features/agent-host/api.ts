// Cliente HTTP de UN agent-host. No usa el axios global de la app: ese lleva el
// `baseURL` del server de ia-flow (features/servers/selection.ts), y acá
// hablamos con otro proceso, en otro origen y con otra credencial.

import type {
  ServerLogEntry,
  ServerLogFilters,
  ServerLogLevel,
  ServerLogLevelCounts,
  SystemPromptBlock,
} from '@ia-flow/shared'
import axios, { type AxiosInstance } from 'axios'

export interface AgentHostProvider {
  id: string
  kind: 'sync' | 'async'
  name: string
  description: string
  available: string[]
}

export interface AgentHostCapacity {
  running: number
  maxConcurrentRuns: number | null
  accepting: boolean
  reason?: string
}

export const ADMISSION_FIELDS = ['repo', 'agentId', 'projectId', 'taskType', 'assignee'] as const
export const ADMISSION_OPS = ['equals', 'notEquals', 'matches', 'notMatches'] as const

export interface AdmissionRule {
  field: (typeof ADMISSION_FIELDS)[number]
  op: (typeof ADMISSION_OPS)[number]
  value: string
}

export interface AgentHostAdmission {
  maxConcurrentRuns: number | null
  rules: AdmissionRule[]
}

export interface AgentHostWorkspace {
  reposBase: string | null
  worktreeBase: string | null
  gitAuthorName: string | null
  gitAuthorEmail: string | null
}

export interface AgentHostRun {
  /** `undefined` en un run inline sin `runId` — no hay con qué correlacionarlo
   *  desde afuera, sólo se sabe que existe. */
  runId?: string
  taskId: string
  agentId?: string
  projectId?: string
  mode: 'inline' | 'detached'
  startedAt: string
}

export interface AgentHostRegistration {
  serverUrl: string
  ok: boolean
  /** Por qué falló el alta — el nombre es el del wire (`RegistrationOutcome`). */
  reason?: string
  /** El `baseUrl` con el que quedó anunciado: por dónde ese server lo alcanza. */
  publicUrl?: string
  at?: string
}

export function agentHostClient(baseUrl: string, token: string): AxiosInstance {
  return axios.create({
    baseURL: baseUrl,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    timeout: 10_000,
  })
}

export async function fetchProvider(c: AxiosInstance): Promise<AgentHostProvider> {
  return (await c.get<AgentHostProvider>('/v1/provider')).data
}

export async function setProvider(c: AxiosInstance, id: string): Promise<AgentHostProvider> {
  return (await c.put<AgentHostProvider>('/v1/provider', { id })).data
}

export async function fetchCapacity(c: AxiosInstance): Promise<AgentHostCapacity> {
  return (await c.get<AgentHostCapacity>('/v1/capacity')).data
}

export async function fetchAdmission(c: AxiosInstance): Promise<AgentHostAdmission> {
  return (await c.get<AgentHostAdmission>('/v1/admission')).data
}

export async function saveAdmission(
  c: AxiosInstance,
  body: AgentHostAdmission,
): Promise<AgentHostAdmission> {
  return (await c.put<AgentHostAdmission>('/v1/admission', body)).data
}

export async function fetchWorkspace(c: AxiosInstance): Promise<AgentHostWorkspace> {
  return (await c.get<AgentHostWorkspace>('/v1/workspace')).data
}

export async function saveWorkspace(
  c: AxiosInstance,
  body: AgentHostWorkspace,
): Promise<AgentHostWorkspace> {
  return (await c.put<AgentHostWorkspace>('/v1/workspace', body)).data
}

export async function fetchSystemPrompt(c: AxiosInstance): Promise<SystemPromptBlock[]> {
  return (await c.get<{ blocks: SystemPromptBlock[] }>('/v1/system-prompt')).data.blocks
}

export async function saveSystemPrompt(
  c: AxiosInstance,
  blocks: SystemPromptBlock[],
): Promise<SystemPromptBlock[]> {
  return (await c.put<{ blocks: SystemPromptBlock[] }>('/v1/system-prompt', { blocks })).data.blocks
}

interface AgentHostLogLineWire {
  raw: string
  time?: string
  level?: number
  module?: string
  msg?: string
  extras?: Record<string, unknown>
}

interface AgentHostLogTailWire {
  /** `null` = este agent-host corre sin archivo de log configurado. */
  file: string | null
  lines: AgentHostLogLineWire[]
  truncated: boolean
}

const LEVEL_NAMES: Record<number, ServerLogLevel> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

const EMPTY_LEVEL_COUNTS: ServerLogLevelCounts = {
  trace: 0,
  debug: 0,
  info: 0,
  warn: 0,
  error: 0,
  fatal: 0,
}

/**
 * Adapta `GET /v1/logs` a la forma que `components/LogStreamSection.vue`
 * espera de cualquier backend — el mismo contrato que ya cumple
 * `fetchServerLogs` del lado del daemon (ver `features/server-logs/api.ts`).
 *
 * Sólo nivel y texto libre viajan: la vista monta esta pantalla con
 * `field-filters="false"` porque el agent-host no tiene módulo/agente/regla/
 * fecha como filtros de servidor — pero `matchLine` (log-tail.ts, del lado
 * del agent-host) ya hace un AND de substrings contra la línea CRUDA, así que
 * "nivel" + "texto libre" son exactamente los dos términos que necesita.
 *
 * Sin archivo configurado, tira: es lo único que este adapter no puede
 * traducir a una lista vacía sin mentir ("no hay resultados" vs "no hay
 * archivo") — `LogStreamSection` ya muestra cualquier excepción de
 * `fetchLogs` en su banda de error.
 */
export async function fetchAgentHostLogs(
  c: AxiosInstance,
  filters: ServerLogFilters,
): Promise<{ entries: ServerLogEntry[]; total: number; levelCounts: ServerLogLevelCounts }> {
  // Sólo `search` viaja al `q` del agent-host — el nivel NO, aunque
  // `matchLine` (log-tail.ts) sepa reconocer una palabra de nivel: mandarlo
  // ahí lo trata como un substring más contra la línea CRUDA, así que una
  // línea `info` cuyo `msg` menciona "error" pasaría un filtro `nivel:error`.
  // El nivel se aplica ACÁ, contra `entry.level` ya parseado — una igualdad,
  // no un substring.
  const { data } = await c.get<AgentHostLogTailWire>('/v1/logs', {
    params: { q: filters.search ?? '', limit: filters.limit ?? 200 },
  })
  if (!data.file) {
    throw new Error('Este agent-host corre sin archivo de log (su stdout va a quien lo levantó)')
  }
  const parsed: ServerLogEntry[] = data.lines
    .filter((line): line is AgentHostLogLineWire & { time: string } => Boolean(line.time))
    .map((line) => ({
      level: LEVEL_NAMES[line.level ?? 30] ?? 'info',
      time: line.time,
      module: line.module,
      msg: line.msg ?? line.raw,
      extras: line.extras,
    }))
  // El agent-host siempre devuelve su tail en orden cronológico ascendente
  // (log-tail.ts#tailFrom); el default del componente es "Fecha ▼" (más
  // nuevo primero), y con `sortable=false` ese pedido nunca cambia — así que
  // se resuelve acá, una vez, en vez de mentir un orden que no aplicó.
  const sorted = [...parsed].sort((a, b) => a.time.localeCompare(b.time))
  if (filters.sort !== 'asc') sorted.reverse()
  // El resumen por nivel es del SET COMPLETO ignorando el filtro de nivel
  // (mismo contrato que fetchServerLogs — ver server-logs/api.ts): si se
  // calculara sobre `entries` ya filtradas, tildar "error" pondría el resto
  // de los chips en 0 sin forma de saber cuántas hay para volver.
  const levelCounts = { ...EMPTY_LEVEL_COUNTS }
  for (const entry of sorted) levelCounts[entry.level] += 1
  const entries = filters.level ? sorted.filter((entry) => entry.level === filters.level) : sorted
  return { entries, total: entries.length, levelCounts }
}

export async function fetchRuns(
  c: AxiosInstance,
): Promise<{ running: number; runs: AgentHostRun[] }> {
  return (await c.get<{ running: number; runs: AgentHostRun[] }>('/v1/runs')).data
}

export async function fetchRegistrations(c: AxiosInstance): Promise<{
  serverUrls: string[]
  registrations: AgentHostRegistration[]
}> {
  return (await c.get('/v1/registrations')).data
}

export async function addRegistration(c: AxiosInstance, serverUrl: string): Promise<void> {
  await c.post('/v1/registrations', { serverUrl })
}

export async function removeRegistration(c: AxiosInstance, serverUrl: string): Promise<void> {
  // El agent-host lee `?serverUrl=`, no el body: un DELETE con cuerpo lo
  // ignoraba y contestaba 400 «falta ?serverUrl=», así que la × no daba de
  // baja nada.
  await c.delete('/v1/registrations', { params: { serverUrl } })
}

/** Mensaje legible de un fallo del agentHost — el 401 y el "no llegué" son los
 *  dos casos que el operador ve seguido y necesita distinguir. */
export function agentHostErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.response?.status === 401) return 'Token inválido para este agent-host'
    const detail = (err.response?.data as { error?: string } | undefined)?.error
    if (detail) return detail
    if (!err.response) return `No respondió (${err.message})`
    return `${err.response.status} ${err.response.statusText}`
  }
  return err instanceof Error ? err.message : String(err)
}
