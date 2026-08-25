// Cliente HTTP de UN gateway. No usa el axios global de la app: ese lleva el
// `baseURL` del server de ia-flow (features/servers/selection.ts), y acá
// hablamos con otro proceso, en otro origen y con otra credencial.

import axios, { type AxiosInstance } from 'axios'

export interface GatewayProvider {
  id: string
  kind: 'sync' | 'async'
  name: string
  description: string
  available: string[]
}

export interface GatewayCapacity {
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

export interface GatewayAdmission {
  maxConcurrentRuns: number | null
  rules: AdmissionRule[]
}

export interface GatewayWorkspace {
  reposBase: string | null
  worktreeBase: string | null
  gitAuthorName: string | null
  gitAuthorEmail: string | null
}

export interface GatewayLogLine {
  raw: string
  time?: string
  level?: number
  scope?: string
  msg?: string
  extras?: Record<string, unknown>
}

export interface GatewayLogTail {
  /** `null` = este gateway corre sin archivo de log. */
  file: string | null
  lines: GatewayLogLine[]
  /** El filtro no alcanzó a mirar todo el archivo. */
  truncated: boolean
}

export interface GatewayRegistration {
  serverUrl: string
  ok: boolean
  error?: string
  at?: string
}

export function gatewayClient(baseUrl: string, token: string): AxiosInstance {
  return axios.create({
    baseURL: baseUrl,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    timeout: 10_000,
  })
}

export async function fetchProvider(c: AxiosInstance): Promise<GatewayProvider> {
  return (await c.get<GatewayProvider>('/v1/provider')).data
}

export async function setProvider(c: AxiosInstance, id: string): Promise<GatewayProvider> {
  return (await c.put<GatewayProvider>('/v1/provider', { id })).data
}

export async function fetchCapacity(c: AxiosInstance): Promise<GatewayCapacity> {
  return (await c.get<GatewayCapacity>('/v1/capacity')).data
}

export async function fetchAdmission(c: AxiosInstance): Promise<GatewayAdmission> {
  return (await c.get<GatewayAdmission>('/v1/admission')).data
}

export async function saveAdmission(
  c: AxiosInstance,
  body: GatewayAdmission,
): Promise<GatewayAdmission> {
  return (await c.put<GatewayAdmission>('/v1/admission', body)).data
}

export async function fetchWorkspace(c: AxiosInstance): Promise<GatewayWorkspace> {
  return (await c.get<GatewayWorkspace>('/v1/workspace')).data
}

export async function saveWorkspace(
  c: AxiosInstance,
  body: GatewayWorkspace,
): Promise<GatewayWorkspace> {
  return (await c.put<GatewayWorkspace>('/v1/workspace', body)).data
}

export async function fetchLogs(c: AxiosInstance, query = ''): Promise<GatewayLogTail> {
  return (await c.get<GatewayLogTail>('/v1/logs', { params: { q: query, limit: 200 } })).data
}

export async function fetchRegistrations(c: AxiosInstance): Promise<{
  serverUrls: string[]
  registrations: GatewayRegistration[]
}> {
  return (await c.get('/v1/registrations')).data
}

export async function addRegistration(c: AxiosInstance, serverUrl: string): Promise<void> {
  await c.post('/v1/registrations', { serverUrl })
}

export async function removeRegistration(c: AxiosInstance, serverUrl: string): Promise<void> {
  await c.delete('/v1/registrations', { data: { serverUrl } })
}

/** Mensaje legible de un fallo del gateway — el 401 y el "no llegué" son los
 *  dos casos que el operador ve seguido y necesita distinguir. */
export function gatewayErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.response?.status === 401) return 'Token inválido para este gateway'
    const detail = (err.response?.data as { error?: string } | undefined)?.error
    if (detail) return detail
    if (!err.response) return `No respondió (${err.message})`
    return `${err.response.status} ${err.response.statusText}`
  }
  return err instanceof Error ? err.message : String(err)
}
