import type {
  HostResources,
  Ingress,
  IngressSource,
  MachineResources,
  RunnerInfo,
  RunnerLogLine,
  RunnerResources,
} from '@ia-flow/shared'
import { formatRelative } from '@/composables/formatRelative'

// Qué está mal en un runner, con lo que ya expone: puro, sin red. Es la misma decisión que el menú de
// Mac (`apps/menubar/RunnerHealth.swift`): los umbrales, el orden y los textos salen de ahí.
//
// Cada parte del estado puede ser `null` —el runner no la expone (404/501): es anterior— o
// `undefined` —no se pudo leer esta vez—. Ninguna de las dos se dibuja (R13); la primera, además,
// deja una nota para actualizarlo.

/** `GET /api/webhooks/status`: lo que se mira de él (no está en `@ia-flow/shared`). */
export interface WebhookStatus {
  secretConfigured?: boolean
  executions?: { running: number; waiting: number; paused: number }
}

/** La ocupación que ya tiene la bandeja (`/api/inbox`): lo que corre, lo que espera y el tope. */
export interface Occupancy {
  running: number
  waiting: number
  /** Lugares libres; sin tope (o runner viejo), ausente. */
  free?: number
  max?: number
}

export interface HealthSnapshot {
  /** Cuándo se revisó (epoch ms). */
  checkedAt: number
  /** `/health` contestó. */
  alive: boolean
  latencyMs?: number
  /** Por qué no responde. */
  failure?: string
  info?: RunnerInfo | null
  webhooks?: WebhookStatus | null
  ingress?: Ingress | null
  resources?: RunnerResources | null
  /** Los últimos warn/error del log; `null` si el runner no expone `/api/logs`. */
  problems?: RunnerLogLine[] | null
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'off'

export interface Issue {
  tone: Tone
  text: string
}

export interface Verdict {
  title: 'No responde' | 'Con problemas' | 'A tope' | 'Responde, con avisos' | 'Todo bien'
  tone: Tone
}

/** Memoria o disco al 80 % avisa; al 90 %, problema (el OOM mata el pod, un disco lleno corta los clones). */
export const WARN_RATIO = 0.8
export const BAD_RATIO = 0.9
/** Sin eventos de GitHub desde hace tanto, se avisa. */
export const GITHUB_QUIET_MS = 2 * 60 * 60 * 1000
/** Un host que no da señales desde hace tanto, se perdió. */
export const HOST_LOST_MS = 2 * 60 * 1000

export const ratioOf = (u: { used_bytes: number; total_bytes: number }): number =>
  u.total_bytes > 0 ? u.used_bytes / u.total_bytes : 0
export const percent = (ratio: number): number => Math.round(Math.min(Math.max(ratio, 0), 1) * 100)
export const toneOfRatio = (ratio: number): Tone =>
  ratio >= BAD_RATIO ? 'bad' : ratio >= WARN_RATIO ? 'warn' : 'ok'

/** `1.5` → `1.5`, `2.0` → `2`. */
export function formatCpus(cpus: number): string {
  return Number.isInteger(cpus) ? String(cpus) : cpus.toFixed(1)
}

/** `1.2 GB`, `512 MB`. */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1_073_741_824
  if (gb >= 1) return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`
  return `${(bytes / 1_048_576).toFixed(0)} MB`
}

export const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`

function machineIssues(machine: MachineResources, name: string): Issue[] {
  const list: Issue[] = []
  for (const [label, usage] of [
    ['memoria', machine.memory],
    ['disco', machine.disk],
  ] as const) {
    if (!usage) continue
    const ratio = ratioOf(usage)
    if (ratio >= WARN_RATIO)
      list.push({ tone: toneOfRatio(ratio), text: `${name}: ${label} al ${percent(ratio)} %` })
  }
  const load = machine.load
  if (load && load.cpus > 0 && load.load1 / load.cpus >= 1.5)
    list.push({
      tone: 'warn',
      text: `${name}: carga ${load.load1.toFixed(1)} con ${formatCpus(load.cpus)} CPU`,
    })
  return list
}

const machinesOf = (r: RunnerResources): MachineResources[] => [
  r.runner,
  ...r.hosts.flatMap((h) => (h.resources ? [h.resources] : [])),
]

/** Algo está a tope: sin lugares (el runner o un host), o memoria/disco al 90 %. */
export function saturated(h: HealthSnapshot, occupancy?: Occupancy | null): boolean {
  if (occupancy?.free === 0) return true
  const r = h.resources
  if (!r) return false
  return (
    r.hosts.some((host) => host.running >= host.max_concurrent) ||
    machinesOf(r).some(
      (m) =>
        (m.memory ? ratioOf(m.memory) : 0) >= BAD_RATIO ||
        (m.disk ? ratioOf(m.disk) : 0) >= BAD_RATIO,
    )
  )
}

const githubOf = (ingress?: Ingress | null): IngressSource | undefined =>
  ingress?.sources.find((s) => s.id === 'github')

function githubIssues(h: HealthSnapshot, now: number): Issue[] {
  const github = githubOf(h.ingress)
  if (!github?.configured) return []
  const last = github.last_at ? Date.parse(github.last_at) : Number.NaN
  if (Number.isNaN(last))
    return [{ tone: 'warn', text: 'Todavía no llegó ningún evento de GitHub.' }]
  if (now - last < GITHUB_QUIET_MS) return []
  return [
    {
      tone: 'warn',
      text: `No llegan eventos de GitHub ${formatRelative(github.last_at as string, now)}. Si nadie movió el board, puede ser normal.`,
    },
  ]
}

function hostIssues(host: HostResources, waiting: number, now: number): Issue[] {
  const list: Issue[] = []
  const seen = Date.parse(host.last_seen)
  if (!Number.isNaN(seen) && now - seen > HOST_LOST_MS)
    list.push({
      tone: 'bad',
      text: `${host.name} no da señales ${formatRelative(host.last_seen, now)}.`,
    })
  else if (host.running >= host.max_concurrent && waiting > 0)
    list.push({
      tone: 'warn',
      text: `${host.name} a tope (${host.running}/${host.max_concurrent}) con trabajo en cola.`,
    })
  if (host.resources) list.push(...machineIssues(host.resources, host.name))
  return list
}

/** Lo que el runner no expone: no está roto, es anterior. */
function staleNotes(h: HealthSnapshot): Issue[] {
  const list: Issue[] = []
  if (h.resources === null)
    list.push({
      tone: 'info',
      text: 'Este runner no expone /api/resources: actualizalo para ver memoria, disco y worktrees.',
    })
  if (h.problems === null)
    list.push({
      tone: 'info',
      text: 'Este runner no expone /api/logs: actualizalo para ver sus errores.',
    })
  return list
}

export const RANK: Record<Tone, number> = { bad: 0, warn: 1, ok: 2, off: 3, info: 4 }

/** Lo que está mal o falta, de lo más grave a lo menos. Sin nada de tono `warn`/`bad`: todo bien. */
export function issuesOf(
  h: HealthSnapshot,
  occupancy?: Occupancy | null,
  now = Date.now(),
): Issue[] {
  if (!h.alive)
    return [{ tone: 'bad', text: `No responde: ${h.failure ?? 'sin respuesta de /health'}` }]
  const list: Issue[] = []
  if (h.webhooks?.secretConfigured === false)
    list.push({ tone: 'bad', text: 'Sin secreto de webhook: GitHub no puede entregar eventos.' })
  list.push(...githubIssues(h, now))
  if (occupancy?.free === 0 && occupancy.waiting > 0)
    list.push({ tone: 'warn', text: `Sin lugar libre: ${occupancy.waiting} en cola.` })
  if (h.resources) {
    list.push(...machineIssues(h.resources.runner, 'El runner'))
    for (const host of h.resources.hosts)
      list.push(...hostIssues(host, occupancy?.waiting ?? 0, now))
  }
  const errors = h.problems?.filter((l) => l.level === 'error').length ?? 0
  if (errors > 0)
    list.push({ tone: 'warn', text: `${plural(errors, 'error', 'errores')} en el log reciente.` })
  list.push(...staleNotes(h))
  // De lo más grave a lo menos; el orden de llegada desempata.
  return list
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => RANK[a.issue.tone] - RANK[b.issue.tone] || a.i - b.i)
    .map((x) => x.issue)
}

/** Lo que hay que mirar: los avisos y problemas, sin las notas. */
export const toLook = (issues: Issue[]): Issue[] =>
  issues.filter((i) => i.tone === 'bad' || i.tone === 'warn')

/** «N cosas para mirar». */
export const toLookTitle = (n: number): string => `${n} ${n === 1 ? 'cosa' : 'cosas'} para mirar`

/** El veredicto de arriba, como el menú: caído > problemas > a tope > avisos > todo bien. */
export function verdictOf(
  h: HealthSnapshot,
  issues: Issue[],
  occupancy?: Occupancy | null,
): Verdict {
  if (!h.alive) return { title: 'No responde', tone: 'bad' }
  if (issues.some((i) => i.tone === 'bad')) return { title: 'Con problemas', tone: 'bad' }
  if (saturated(h, occupancy)) return { title: 'A tope', tone: 'warn' }
  if (issues.some((i) => i.tone === 'warn')) return { title: 'Responde, con avisos', tone: 'warn' }
  return { title: 'Todo bien', tone: 'ok' }
}
