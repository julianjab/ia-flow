import type {
  EventLogEntry,
  Inbox,
  InboxGroup,
  InboxItem,
  TaskAction,
  TaskActionResult,
  TaskDetail,
  TraceEntry,
} from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { serverTarget } from '@/composables/useServerTarget'
import { getInbox, getTaskDetail, postTaskAction } from '@/features/inbox/api'
import { GROUPS } from '@/features/inbox/labels'
import { connectRunnerStream, type StreamState } from '@/features/inbox/stream'

export interface DetailState {
  loading: boolean
  error: string | null
  data: TaskDetail | null
}

export interface ActionState {
  pending: boolean
  result: TaskActionResult | null
  error: string | null
}

/** Líneas de traza que se conservan en vivo: una ejecución larga no crece sin tope. */
const TRACE_CAP = 500
const REFRESH_DEBOUNCE_MS = 250

export const useInboxStore = defineStore('inbox', () => {
  const inbox = ref<Inbox | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** Filtro por proyecto (`null` = todos). Sólo se ofrece con más de uno. */
  const project = ref<string | null>(null)
  /** Filtro por grupo (`null` = los cuatro): los contadores del resumen. */
  const groupFilter = ref<InboxGroup | null>(null)

  const openRef = ref<string | null>(null)
  /** La tarea abierta se ve en grande (el panel de detalle), no sólo dentro de su tarjeta. */
  const expanded = ref(false)
  const details = ref<Record<string, DetailState>>({})
  const actions = ref<Record<string, ActionState>>({})
  const streamState = ref<StreamState>('connecting')

  const projects = computed(() => inbox.value?.projects ?? [])

  /** Lo que se ve tras el filtro de proyecto: la base de contadores y secciones. */
  const scoped = computed<InboxItem[]>(() => {
    const items = inbox.value?.items ?? []
    return project.value ? items.filter((i) => i.project_id === project.value) : items
  })

  const counts = computed<Record<Exclude<InboxGroup, 'idle'>, number>>(() => {
    const out = { need: 0, fail: 0, run: 0, queue: 0 }
    for (const item of scoped.value) if (item.group in out) out[item.group as keyof typeof out]++
    return out
  })

  const sections = computed(() =>
    GROUPS.filter((g) => !groupFilter.value || groupFilter.value === g).map((group) => ({
      group,
      items: scoped.value.filter((i) => i.group === group),
    })),
  )

  const total = computed(() => scoped.value.length)

  // ── carga ────────────────────────────────────────────────────────────────

  let refreshSeq = 0
  async function refresh(): Promise<void> {
    const seq = ++refreshSeq
    // Sólo la primera carga muestra "cargando": un refresco por el stream no
    // debe hacer parpadear la bandeja.
    if (!inbox.value) loading.value = true
    try {
      const next = await getInbox()
      if (seq !== refreshSeq) return
      inbox.value = next
      error.value = null
      // Un proyecto que ya no existe no puede seguir filtrando.
      if (project.value && !next.projects.some((p) => p.id === project.value)) project.value = null
    } catch (err) {
      if (seq === refreshSeq) error.value = extractErrorMessage(err)
    } finally {
      if (seq === refreshSeq) loading.value = false
    }
  }

  async function loadDetail(ref: string, opts: { silent?: boolean } = {}): Promise<void> {
    const prev = details.value[ref]
    details.value = {
      ...details.value,
      [ref]: { loading: !opts.silent || !prev?.data, error: null, data: prev?.data ?? null },
    }
    try {
      const data = await getTaskDetail(ref)
      details.value = { ...details.value, [ref]: { loading: false, error: null, data } }
    } catch (err) {
      details.value = {
        ...details.value,
        [ref]: { loading: false, error: extractErrorMessage(err), data: prev?.data ?? null },
      }
    }
  }

  function toggle(ref: string): void {
    expanded.value = false
    if (openRef.value === ref) {
      openRef.value = null
      return
    }
    openRef.value = ref
    void loadDetail(ref)
  }

  /** El detalle completo de una tarea, en grande. Sigue siendo la abierta: la traza y los
   *  eventos le llegan en vivo igual. */
  function expand(ref: string): void {
    if (openRef.value !== ref) {
      openRef.value = ref
      void loadDetail(ref)
    }
    expanded.value = true
  }

  function collapse(): void {
    expanded.value = false
  }

  /** Abre una tarea pedida desde afuera (el asistente): sin filtros que la escondan. */
  function focus(ref: string): void {
    groupFilter.value = null
    const item = inbox.value?.items.find((i) => i.ref === ref)
    if (item && project.value && item.project_id !== project.value) project.value = null
    if (openRef.value === ref) return
    openRef.value = ref
    void loadDetail(ref)
  }

  function setGroupFilter(group: InboxGroup | null): void {
    groupFilter.value = groupFilter.value === group ? null : group
  }

  // ── acciones ─────────────────────────────────────────────────────────────

  /**
   * Ejecuta una acción con el token de GitHub del usuario. El que la llama ya
   * verificó que hay sesión: sin token no hay request.
   */
  async function runAction(
    ref: string,
    action: TaskAction,
    githubToken: string,
    comment?: string,
  ): Promise<TaskActionResult | null> {
    actions.value = { ...actions.value, [ref]: { pending: true, result: null, error: null } }
    try {
      const result = await postTaskAction(
        ref,
        { action, ...(comment ? { comment } : {}) },
        githubToken,
      )
      actions.value = { ...actions.value, [ref]: { pending: false, result, error: null } }
      if (result.ok) {
        await refresh()
        if (openRef.value === ref) void loadDetail(ref, { silent: true })
      }
      return result
    } catch (err) {
      actions.value = {
        ...actions.value,
        [ref]: { pending: false, result: null, error: extractErrorMessage(err) },
      }
      return null
    }
  }

  function clearAction(ref: string): void {
    const { [ref]: _gone, ...rest } = actions.value
    actions.value = rest
  }

  // ── en vivo ──────────────────────────────────────────────────────────────

  function appendTrace(entry: TraceEntry): void {
    const ref = openRef.value
    const detail = ref ? details.value[ref]?.data : null
    if (!ref || !detail) return
    const executionId = detail.trace.at(-1)?.execution_id ?? detail.item.execution?.id
    if (executionId && entry.execution_id !== executionId) return
    const trace = [...detail.trace, entry].slice(-TRACE_CAP)
    details.value = {
      ...details.value,
      [ref]: { loading: false, error: null, data: { ...detail, trace } },
    }
  }

  function appendEvent(entry: EventLogEntry): void {
    const ref = openRef.value
    const detail = ref ? details.value[ref]?.data : null
    if (!ref || !detail || entry.task_ref !== ref) return
    if (detail.events.some((e) => e.id === entry.id)) return
    details.value = {
      ...details.value,
      [ref]: {
        loading: false,
        error: null,
        data: { ...detail, events: [...detail.events, entry] },
      },
    }
  }

  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleRefresh(): void {
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refresh()
    }, REFRESH_DEBOUNCE_MS)
  }

  let stream: { close(): void } | null = null

  /** Carga la bandeja y se suscribe al stream. Idempotente. */
  function start(): void {
    void refresh()
    if (stream) return
    stream = connectRunnerStream({
      url: () => {
        const target = serverTarget()
        const query = target.token ? `?token=${encodeURIComponent(target.token)}` : ''
        return `${target.url('/api/stream')}${query}`
      },
      onState: (s) => {
        streamState.value = s
      },
      onPoll: () => void refresh(),
      onEvent: (event) => {
        if (event.type === 'inbox') {
          scheduleRefresh()
          if (openRef.value && event.refs.includes(openRef.value)) {
            void loadDetail(openRef.value, { silent: true })
          }
        } else if (event.type === 'trace') appendTrace(event.entry)
        else appendEvent(event.entry)
      },
    })
  }

  function stop(): void {
    stream?.close()
    stream = null
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = null
  }

  return {
    inbox,
    loading,
    error,
    project,
    groupFilter,
    openRef,
    expanded,
    details,
    actions,
    streamState,
    projects,
    scoped,
    counts,
    sections,
    total,
    refresh,
    loadDetail,
    toggle,
    expand,
    collapse,
    focus,
    setGroupFilter,
    runAction,
    clearAction,
    start,
    stop,
  }
})
