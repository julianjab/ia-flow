// Cliente HTTP de UN agent-host. No usa el axios global de la app: ese lleva el
// `baseURL` del server de ia-flow (features/servers/selection.ts), y acá
// hablamos con otro proceso, en otro origen y con otra credencial.

import type { SystemPromptBlock } from '@ia-flow/shared'
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

export interface AgentHostLogLine {
  raw: string
  time?: string
  level?: number
  module?: string
  msg?: string
  extras?: Record<string, unknown>
}

export interface AgentHostLogTail {
  /** `null` = este agentHost corre sin archivo de log. */
  file: string | null
  lines: AgentHostLogLine[]
  /** El filtro no alcanzó a mirar todo el archivo. */
  truncated: boolean
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

export async function fetchLogs(c: AxiosInstance, query = ''): Promise<AgentHostLogTail> {
  return (await c.get<AgentHostLogTail>('/v1/logs', { params: { q: query, limit: 200 } })).data
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
