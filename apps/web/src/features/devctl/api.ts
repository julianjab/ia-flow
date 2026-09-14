// Bridge fino sobre `window.iaFlowDesktop.devctl` — control de los 4 procesos
// de dev locales del monorepo (server, web, agent-host-fe, agent-host-be)
// desde la app de escritorio.
//
// El bridge SOLO existe cuando esta web corre dentro de Electron: lo expone
// `apps/desktop/src/preload.ts` detrás del flag `--ia-flow-trusted`, mismo
// patrón que ya usa `ServerPickerView.vue` para detectar el entorno. Visitada
// desde un navegador normal, cada función acá cae a un valor vacío en vez de
// tirar — el panel se apaga solo (ver `isDevctlAvailable`), no falla feo.
//
// No hay tipos compartidos para este contrato: es específico de esta feature,
// nadie más del server ni de `@ia-flow/shared` habla devctl.

export type DevMode = 'dev' | 'run'

export interface DevProcStatus {
  id: string
  label: string
  defaultPort: number
  /** `true` sólo si ESTA app de escritorio lo levantó — es lo único que se puede parar. */
  managed: boolean
  /** Hay algo escuchando en el puerto vigente, gestionado por nosotros o no. */
  portOpen: boolean
  mode: DevMode | null
  port: number | null
  pid: number | null
  startedAt: number | null
  lastExit: { code: number | null; signal: string | null } | null
}

export type DevctlResult = { ok: true } | { ok: false; error: string }

interface DevctlBridge {
  status: () => Promise<DevProcStatus[]>
  logs: (id: string) => Promise<string[]>
  start: (id: string, mode: DevMode, port: number) => Promise<DevctlResult>
  stop: (id: string) => Promise<DevctlResult>
}

function bridge(): DevctlBridge | undefined {
  if (!('iaFlowDesktop' in globalThis)) return undefined
  return (globalThis as { iaFlowDesktop?: { devctl?: DevctlBridge } }).iaFlowDesktop?.devctl
}

export function isDevctlAvailable(): boolean {
  return !!bridge()
}

export async function fetchStatus(): Promise<DevProcStatus[]> {
  const b = bridge()
  if (!b) return []
  return b.status()
}

export async function fetchLogs(id: string): Promise<string[]> {
  const b = bridge()
  if (!b) return []
  return b.logs(id)
}

const UNAVAILABLE: DevctlResult = { ok: false, error: 'devctl no disponible en este navegador' }

export async function startProcess(id: string, mode: DevMode, port: number): Promise<DevctlResult> {
  const b = bridge()
  if (!b) return UNAVAILABLE
  return b.start(id, mode, port)
}

export async function stopProcess(id: string): Promise<DevctlResult> {
  const b = bridge()
  if (!b) return UNAVAILABLE
  return b.stop(id)
}
