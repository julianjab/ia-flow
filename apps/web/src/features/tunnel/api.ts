import axios from 'axios'

export type TunnelState = 'stopped' | 'starting' | 'running' | 'error'

export interface TunnelStatus {
  state: TunnelState
  url: string | null
  webhookUrl: string | null
  startedAt: string | null
  error: string | null
  installed: boolean
  recentLog: string[]
}

const STATES: TunnelState[] = ['stopped', 'starting', 'running', 'error']

// The dev proxy can answer with HTML (404/502) and axios would hand us that as
// `data`. Anything that isn't a TunnelStatus becomes a thrown error instead of
// a broken shape in the store (the template reads `recentLog.length`).
function parseTunnelStatus(data: unknown): TunnelStatus {
  const d = data as Partial<TunnelStatus> | null
  if (
    !d ||
    typeof d !== 'object' ||
    !STATES.includes(d.state as TunnelState) ||
    !Array.isArray(d.recentLog) ||
    typeof d.installed !== 'boolean'
  ) {
    throw new Error('Respuesta inesperada de /api/tunnel')
  }
  return d as TunnelStatus
}

export async function getTunnelStatus(): Promise<TunnelStatus> {
  const { data } = await axios.get<unknown>('/api/tunnel')
  return parseTunnelStatus(data)
}

// El server exige este header en las rutas que mutan el túnel: al no ser una
// "simple request", el browser hace preflight y una página cualquiera no puede
// abrirte un túnel público por CSRF.
const LOCAL_HEADER = { 'x-ia-flow-local': '1' }

export async function startTunnel(): Promise<TunnelStatus> {
  // 500 means "couldn't even launch" (binary missing) and still carries a
  // TunnelStatus body — surface it instead of throwing. Any other non-200 is
  // a genuine transport failure and must not reach the store.
  const { data } = await axios.post<unknown>('/api/tunnel/start', null, {
    headers: LOCAL_HEADER,
    validateStatus: (s) => s === 200 || s === 500,
  })
  return parseTunnelStatus(data)
}

export async function stopTunnel(): Promise<TunnelStatus> {
  const { data } = await axios.post<unknown>('/api/tunnel/stop', null, { headers: LOCAL_HEADER })
  return parseTunnelStatus(data)
}

// ─── Estado del daemon (modo por proyecto) ────────────────────────────────

export interface WebhookProjectStatus {
  projectId: string
  name: string
  mode: 'webhook' | 'polling'
  webhook: {
    lastEventAt: string | null
    lastReason: string | null
    lastScanAt: string | null
    fallbackIntervalMs: number
    /** false = todavía no llegó ningún delivery; el respaldo corre rápido. */
    deliveryReceived: boolean
  } | null
}

export interface WebhookStatus {
  defaultMode: 'webhook' | 'polling'
  secretConfigured: boolean
  endpoint: string
  projects: WebhookProjectStatus[]
}

export async function getWebhookStatus(): Promise<WebhookStatus> {
  const { data } = await axios.get<WebhookStatus>('/api/webhooks/status')
  return data
}
