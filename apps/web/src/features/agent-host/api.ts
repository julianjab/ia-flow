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

// El agent-host no pagina — `GET /v1/logs` es una ventana de tail (hasta
// SCAN_BYTES=4MB escaneados, log-tail.ts), no un `OFFSET` de SQL. El
// componente manda su propio `filters.limit` (PAGE_LIMIT=50, pensado para el
// `LIMIT`/`OFFSET` del daemon) y esperaría poder pedir la página siguiente —
// que acá no existe: `total` siempre es `entries.length`, así que "Cargar
// más" no se ofrece nunca. Por eso este adapter IGNORA `filters.limit` y pide
// siempre una ventana generosa y fija — la misma que tenía el card viejo
// (AgentHostLogsCard, antes de compartir esta vista) antes de que hubiera
// paginación de la que hablar.
const WINDOW_LINES = 200

async function fetchTail(c: AxiosInstance, q: string): Promise<AgentHostLogTailWire> {
  return (await c.get<AgentHostLogTailWire>('/v1/logs', { params: { q, limit: WINDOW_LINES } }))
    .data
}

/**
 * Una línea que no parseó como JSON (`log-tail.ts#parseLine` devuelve
 * `{ raw }` sin más campos: stack traces crudos, stdout de un boot que se
 * cae, una línea a medio escribir) no tiene con qué llenar el `time`
 * obligatorio de `ServerLogEntry`. Descartarla sería justo lo que
 * `AgentHostLogsCard` (el card viejo) no hacía — se mostraba con `raw`, que
 * es lo primero que uno busca cuando esta pantalla existe. `Date.now()` es
 * aproximado (no hay timestamp real que recuperar), pero una línea visible
 * con la hora aproximada es mejor que una que desaparece en silencio.
 */
function toServerLogEntry(line: AgentHostLogLineWire): ServerLogEntry {
  return {
    level: LEVEL_NAMES[line.level ?? 30] ?? 'info',
    time: line.time ?? new Date().toISOString(),
    module: line.module,
    msg: line.msg ?? line.raw,
    extras: line.extras,
  }
}

function sortByTime(entries: ServerLogEntry[], sort: ServerLogFilters['sort']): ServerLogEntry[] {
  // El agent-host siempre devuelve su tail en orden cronológico ascendente;
  // el default del componente es "Fecha ▼" (más nuevo primero) y, con
  // `sortable=false`, ese pedido nunca cambia — se resuelve acá una vez, en
  // vez de mentir un orden que el agent-host no aplicó.
  const sorted = [...entries].sort((a, b) => a.time.localeCompare(b.time))
  if (sort !== 'asc') sorted.reverse()
  return sorted
}

/**
 * Adapta `GET /v1/logs` a la forma que `components/LogStreamSection.vue`
 * espera de cualquier backend — el mismo contrato que ya cumple
 * `fetchServerLogs` del lado del daemon (ver `features/server-logs/api.ts`).
 *
 * Sólo nivel y texto libre viajan: la vista monta esta pantalla con
 * `field-filters="false"` porque el agent-host no tiene módulo/agente/regla/
 * fecha como filtros de servidor.
 *
 * El nivel se manda EN `q` (`matchLine` ya sabe reconocer una palabra de
 * nivel contra `"level":50`) para que la ventana de `WINDOW_LINES` se llene
 * con líneas de ESE nivel buscando más atrás en el archivo — filtrar sólo
 * del lado del cliente sobre una ventana ya recortada encontraría los
 * errores salvo justo los más viejos, que es el modo de falla que
 * `apps/agent-host/src/app.ts` ya documenta para `/v1/capacity`. Y se vuelve
 * a chequear con IGUALDAD contra `entry.level` ya parseado, porque `matchLine`
 * matchea por substring: una línea `info` cuyo `msg` dice "error" pasaría el
 * filtro del lado del servidor sin este segundo chequeo.
 *
 * El resumen por nivel es una consulta APARTE, sin el término de nivel, para
 * que el breakdown sea del set completo — mismo contrato que
 * `fetchServerLogs` (server-logs/api.ts): si se calculara sobre las entries
 * ya filtradas, tildar "error" pondría el resto de los chips en 0 sin forma
 * de volver. Sale gratis cuando no hay nivel activo (es la misma llamada).
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
  const search = filters.search ?? ''
  const unfiltered = await fetchTail(c, search)
  if (!unfiltered.file) {
    throw new Error('Este agent-host corre sin archivo de log (su stdout va a quien lo levantó)')
  }
  const allEntries = sortByTime(unfiltered.lines.map(toServerLogEntry), filters.sort)
  const levelCounts = { ...EMPTY_LEVEL_COUNTS }
  for (const entry of allEntries) levelCounts[entry.level] += 1

  if (!filters.level) return { entries: allEntries, total: allEntries.length, levelCounts }

  const byLevel = await fetchTail(c, [filters.level, search].join(' ').trim())
  const entries = sortByTime(byLevel.lines.map(toServerLogEntry), filters.sort).filter(
    (entry) => entry.level === filters.level,
  )
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
