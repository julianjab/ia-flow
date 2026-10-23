import type { HostResources, IngressSource, MachineResources, RunnerLogLine } from '@ia-flow/shared'
import { formatRelative } from '@/composables/formatRelative'
import {
  formatBytes,
  formatCpus,
  GITHUB_QUIET_MS,
  type HealthSnapshot,
  HOST_LOST_MS,
  type Occupancy,
  percent,
  plural,
  RANK,
  ratioOf,
  type Tone,
  toneOfRatio,
} from '@/features/runner-health/status'

// Las filas de «Estado del runner», una por cosa, con lo que el runner expone. Puro. Lo que no
// llegó no se dibuja (R13).

export interface HealthRow {
  id: string
  label: string
  detail: string
  tone: Tone
}

function capacityRow(h: HealthSnapshot, occupancy?: Occupancy | null): HealthRow | undefined {
  const counts = h.webhooks?.executions
  const running = occupancy?.running ?? counts?.running
  if (running === undefined) return undefined
  const waiting = occupancy?.waiting ?? counts?.waiting ?? 0
  const max = occupancy?.max
  const parts = [
    max !== undefined ? `${running} de ${max} lugares ocupados` : `${running} corriendo`,
  ]
  if (waiting > 0) parts.push(`${waiting} en cola`)
  if (counts?.paused) parts.push(`${counts.paused} en pausa`)
  const full = occupancy?.free === 0
  return {
    id: 'capacity',
    label: 'Capacidad',
    detail: parts.join(' · '),
    tone: full ? 'warn' : 'ok',
  }
}

function memoryRow(m: MachineResources): HealthRow | undefined {
  if (!m.memory) return undefined
  const ratio = ratioOf(m.memory)
  const of = m.memory.source === 'cgroup' ? 'del contenedor' : 'de la máquina'
  return {
    id: 'memory',
    label: 'Memoria',
    detail: `${percent(ratio)} % ${of} · ${formatBytes(m.memory.used_bytes)} de ${formatBytes(m.memory.total_bytes)}`,
    tone: toneOfRatio(ratio),
  }
}

function diskRow(m: MachineResources): HealthRow | undefined {
  const worktrees =
    m.worktrees !== undefined ? plural(m.worktrees, 'worktree', 'worktrees') : undefined
  if (!m.disk)
    return worktrees ? { id: 'disk', label: 'Disco', detail: worktrees, tone: 'ok' } : undefined
  const ratio = ratioOf(m.disk)
  return {
    id: 'disk',
    label: 'Disco',
    detail: [`${percent(ratio)} %`, worktrees].filter(Boolean).join(' · '),
    tone: toneOfRatio(ratio),
  }
}

function loadRow(m: MachineResources): HealthRow | undefined {
  if (!m.load) return undefined
  const ratio = m.load.cpus > 0 ? m.load.load1 / m.load.cpus : 0
  return {
    id: 'load',
    label: 'Carga',
    detail: `${m.load.load1.toFixed(2)} · ${formatCpus(m.load.cpus)} CPU`,
    tone: ratio >= 1.5 ? 'warn' : 'ok',
  }
}

const worse = (a: Tone, b: Tone): Tone => (RANK[b] < RANK[a] ? b : a)

function hostRow(host: HostResources, now: number): HealthRow {
  const parts = [`${host.running}/${host.max_concurrent} corriendo`]
  let tone: Tone = host.running >= host.max_concurrent ? 'warn' : 'ok'
  for (const [label, usage] of [
    ['memoria', host.resources?.memory],
    ['disco', host.resources?.disk],
  ] as const) {
    if (!usage) continue
    const ratio = ratioOf(usage)
    parts.push(`${label} ${percent(ratio)} %`)
    tone = worse(tone, toneOfRatio(ratio))
  }
  if (host.resources?.worktrees !== undefined)
    parts.push(plural(host.resources.worktrees, 'worktree', 'worktrees'))
  const seen = Date.parse(host.last_seen)
  if (!Number.isNaN(seen) && now - seen > HOST_LOST_MS) {
    parts.push(`último contacto ${formatRelative(host.last_seen, now)}`)
    tone = 'bad'
  }
  return { id: `host:${host.name}`, label: host.name, detail: parts.join(' · '), tone }
}

function sourceRow(s: IngressSource, h: HealthSnapshot, now: number): HealthRow {
  const id = `source:${s.id}`
  if (!s.configured)
    return {
      id,
      label: s.name,
      detail: `sin configurar${s.missing ? ` (falta ${s.missing})` : ''}`,
      tone: s.id === 'github' ? 'bad' : 'off',
    }
  if (s.id === 'github' && h.webhooks?.secretConfigured === false)
    return { id, label: s.name, detail: 'sin secreto de webhook', tone: 'bad' }
  const count = s.count_24h > 0 ? ` · ${s.count_24h} en 24 h` : ''
  if (!s.last_at)
    return {
      id,
      label: s.name,
      detail: 'sin eventos todavía',
      tone: s.id === 'github' ? 'warn' : 'off',
    }
  const quiet = s.id === 'github' && now - Date.parse(s.last_at) >= GITHUB_QUIET_MS
  return {
    id,
    label: s.name,
    detail: quiet
      ? `último evento ${formatRelative(s.last_at, now)} — ¿se cortó el webhook?`
      : `último evento ${formatRelative(s.last_at, now)}${count}`,
    tone: quiet ? 'warn' : 'ok',
  }
}

/**
 * Las filas del estado, en el orden del mockup: Responde, Capacidad, Memoria, Disco (con los
 * worktrees), Carga, los hosts, cada entrada (GitHub, Slack) y el Asistente. Una fila sin su dato
 * no se dibuja (R13): un runner sin `/api/resources` no tiene Memoria ni Disco.
 */
export function rowsOf(
  h: HealthSnapshot,
  occupancy?: Occupancy | null,
  now = Date.now(),
): HealthRow[] {
  if (!h.alive) return []
  const rows: (HealthRow | undefined)[] = []
  const answer = [
    h.latencyMs !== undefined ? `${h.latencyMs} ms` : undefined,
    h.info ? `v${h.info.version}` : undefined,
  ]
  rows.push({
    id: 'alive',
    label: 'Responde',
    detail: answer.filter(Boolean).join(' · ') || 'sí',
    tone: 'ok',
  })
  rows.push(capacityRow(h, occupancy))
  if (h.resources) {
    rows.push(
      memoryRow(h.resources.runner),
      diskRow(h.resources.runner),
      loadRow(h.resources.runner),
    )
    rows.push(...h.resources.hosts.map((host) => hostRow(host, now)))
  }
  for (const s of h.ingress?.sources ?? []) rows.push(sourceRow(s, h, now))
  if (h.info) {
    const agents = h.info.assistant_agents.map((a) => a.label).join(' · ')
    rows.push({
      id: 'assistant',
      label: 'Asistente',
      detail: h.info.assistant
        ? agents
          ? `disponible · ${agents}`
          : 'disponible'
        : 'sin asistente',
      tone: h.info.assistant ? 'ok' : 'off',
    })
  }
  return rows.filter((r): r is HealthRow => r !== undefined)
}

/** Los últimos avisos del log, del más nuevo, hasta `max`. */
export function recentProblems(h: HealthSnapshot, max = 6): RunnerLogLine[] {
  return (h.problems ?? []).slice(-max).reverse()
}
