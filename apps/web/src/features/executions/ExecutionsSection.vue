<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useServerEvents } from '@/composables/useServerEvents';
import { fetchAvailableAgents } from '@/features/projects/availableApi';
import { fetchProjectItems } from '@/features/projects/sourceApi';
import { useProjectsStore } from '@/features/projects/store';
import { fetchServerLogs, type ServerLogEntry } from '@/features/server-logs/api';
import {
  type AgentDefinition,
  ExecutionLogSchema,
  ServerLogEntrySchema,
  type ServerLogLevel,
} from '@ia-flow/shared';
import { type ExecutionLog, fetchExecutions } from './api';

const props = withDefaults(
  defineProps<{ scope?: 'project' | 'global' }>(),
  { scope: 'project' },
);
const isGlobal = computed(() => props.scope === 'global');

// The outcome filter mirrors the shared enum; toggled from the summary
// chip row instead of a dedicated select.
type OutcomeFilter = '' | 'success' | 'error' | 'cancelled' | 'truncated';

const DEFAULT_LIMIT = 100;
const LIMIT_STEP = 100;

// How many server-log entries to pull for the related-logs sub-panel. The
// route caps at 1000 and each execution rarely emits more than a few hundred
// tool.call / tool.result / api.* lines, so 500 is comfortably enough.
const RELATED_LOGS_LIMIT = 500;
// When the execution is still open (finishedAt = null), bound the "to"
// window at now + this margin so we still catch late-arriving log lines
// from an in-flight run.
const OPEN_RUN_TO_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

const projectsStore = useProjectsStore();
const activeProjectId = computed(() => projectsStore.activeProjectId);
const allProjects = computed(() => projectsStore.projects);
const router = useRouter();
// In the global tab (General → Ejecuciones) the operator opts into a
// subset of projects via chips. Empty = todos los proyectos. Ignored when
// scope='project' since ProjectDetailView already scopes to a single one.
const projectFilter = ref<Set<string>>(new Set());
function projectNameFor(id: string): string {
  return allProjects.value.find((p) => p.id === id)?.name ?? id;
}

function openRunInLogs(exec: ExecutionLog) {
  void router.push({ path: '/general/logs', query: { runId: exec.id } });
}

// Server-side filters — the watchers below refetch when any of these change.
// Multi-select Sets: empty = "todos"; any elements = filter to those values.
type OutcomeValue = Exclude<OutcomeFilter, ''>;
const agentFilter = ref<Set<string>>(new Set());
const providerFilter = ref<Set<string>>(new Set());
const outcomeFilter = ref<Set<OutcomeValue>>(new Set());
const fromFilter = ref('');
const toFilter = ref('');
const limit = ref(DEFAULT_LIMIT);

function toggleInSet<T>(current: Set<T>, value: T): Set<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// Client-side filter: filters the already-loaded page by title/taskId.
// Debounced to avoid re-running the computed on every keystroke; we hold the
// applied value in a separate ref so the input stays snappy.
const taskTextInput = ref('');
const taskTextApplied = ref('');
let taskTextDebounce: ReturnType<typeof setTimeout> | null = null;
watch(taskTextInput, (v) => {
  if (taskTextDebounce) clearTimeout(taskTextDebounce);
  taskTextDebounce = setTimeout(() => {
    taskTextApplied.value = v.trim().toLowerCase();
  }, 300);
});

const executions = ref<ExecutionLog[]>([]);
const agents = ref<AgentDefinition[]>([]);
// Providers seen in any loaded execution. Grow-only Set so applying a
// provider filter doesn't collapse the chip row.
const discoveredProviders = ref<Set<string>>(new Set());
const providers = computed<string[]>(() => {
  const s = new Set(discoveredProviders.value);
  for (const p of providerFilter.value) s.add(p);
  return Array.from(s).sort((a, b) => a.localeCompare(b));
});
const loading = ref(false);
const error = ref<string>('');
const expandedId = ref<string | null>(null);

// Per-execution cache for the related-logs sub-panel. Keyed by exec.id so
// re-expanding a card doesn't refetch (unless the user hits "↻ recargar").
const relatedLogs = ref<Record<string, ServerLogEntry[]>>({});
const relatedLoading = ref<Record<string, boolean>>({});
const relatedError = ref<Record<string, string>>({});

// The execution log doesn't carry an issue URL directly, so we fetch the
// project's source items once and build a taskId → issueUrl map. This works
// across sources (GitHub Projects items where the taskId is an opaque node
// id, plain GitHub issues where it's a number, local files, etc.).
const issueUrlByTaskId = ref<Record<string, string>>({});
async function loadIssueUrlMap() {
  // Cross-project issueUrl lookup would need N fetches; skip in global tab.
  if (isGlobal.value) { issueUrlByTaskId.value = {}; return; }
  const pid = activeProjectId.value;
  if (!pid) { issueUrlByTaskId.value = {}; return; }
  try {
    const res = await fetchProjectItems(pid);
    const next: Record<string, string> = {};
    for (const item of res.items ?? []) {
      const url = item.meta?.issueUrl;
      if (typeof url === 'string' && url) next[item.id] = url;
    }
    issueUrlByTaskId.value = next;
  } catch {
    // Non-fatal — the title just stays plain text.
  }
}
function issueUrlFor(taskId: string): string | null {
  return issueUrlByTaskId.value[taskId] ?? null;
}

const filteredExecutions = computed<ExecutionLog[]>(() => {
  const q = taskTextApplied.value;
  if (!q) return executions.value;
  return executions.value.filter((e) =>
    e.taskTitle.toLowerCase().includes(q) || e.taskId.toLowerCase().includes(q),
  );
});

// Client-side column sort over filteredExecutions. Server already returns
// most-recent-first; we let the user re-sort in-place without a refetch.
type ExecSortColumn = 'startedAt' | 'taskTitle' | 'agentId' | 'providerId' | 'duration' | 'outcome';
const execSort = ref<{ column: ExecSortColumn; direction: 'asc' | 'desc' }>({
  column: 'startedAt',
  direction: 'desc',
});
function selectExecColumn(column: ExecSortColumn) {
  if (execSort.value.column === column) {
    execSort.value = {
      column,
      direction: execSort.value.direction === 'asc' ? 'desc' : 'asc',
    };
  } else {
    execSort.value = { column, direction: 'desc' };
  }
}
function execSortArrow(column: ExecSortColumn): string {
  if (execSort.value.column !== column) return '';
  return execSort.value.direction === 'asc' ? ' ▲' : ' ▼';
}
// Tick used to compute live elapsed time for still-open executions. Updated
// every second by the interval below, but only while at least one row is
// still in-flight — otherwise the ref sits idle.
const now = ref(Date.now());
function durationMs(exec: ExecutionLog): number {
  const start = new Date(exec.startedAt).getTime();
  const end = exec.finishedAt ? new Date(exec.finishedAt).getTime() : now.value;
  return end - start;
}
const OUTCOME_RANK: Record<string, number> = {
  success: 0, truncated: 1, cancelled: 2, error: 3, pending: 4,
};
const sortedExecutions = computed<ExecutionLog[]>(() => {
  const arr = [...filteredExecutions.value];
  const { column, direction } = execSort.value;
  const dir = direction === 'asc' ? 1 : -1;
  arr.sort((a, b) => {
    let cmp = 0;
    switch (column) {
      case 'startedAt': cmp = a.startedAt.localeCompare(b.startedAt); break;
      case 'taskTitle': cmp = a.taskTitle.localeCompare(b.taskTitle); break;
      case 'agentId':   cmp = a.agentId.localeCompare(b.agentId); break;
      case 'providerId': cmp = a.providerId.localeCompare(b.providerId); break;
      case 'duration':  cmp = durationMs(a) - durationMs(b); break;
      case 'outcome': {
        const oa = OUTCOME_RANK[a.outcome ?? 'pending'] ?? 99;
        const ob = OUTCOME_RANK[b.outcome ?? 'pending'] ?? 99;
        cmp = oa - ob;
        break;
      }
    }
    return cmp * dir;
  });
  return arr;
});

// Outcome counts across the loaded page — powers the summary chip row.
const OUTCOME_ORDER: Array<'success' | 'error' | 'cancelled' | 'truncated' | 'pending'> = [
  'success', 'error', 'cancelled', 'truncated', 'pending',
];
const outcomeCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = { success: 0, error: 0, cancelled: 0, truncated: 0, pending: 0 };
  for (const e of executions.value) counts[e.outcome ?? 'pending']++;
  return counts;
});
function selectSummaryOutcome(oc: 'success' | 'error' | 'cancelled' | 'truncated' | 'pending') {
  // 'pending' isn't a server-side filter; treat clicks on it as a no-op.
  if (oc === 'pending') return;
  outcomeFilter.value = toggleInSet(outcomeFilter.value, oc);
}

// Compact date column matching the Logs table: HH:MM:SS today, "DD MMM HH:MM"
// for older entries. Full ISO available on hover. Locale falls back to the
// browser's default so a Spanish machine shows "ene" and a US one shows "Jan"
// — everything is rendered in the operator's local timezone.
const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'short' });
function formatDateCompact(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return sameDay ? hms : `${pad(d.getDate())} ${monthFormatter.format(d)} ${hms}`;
}

async function loadAgents() {
  // Agent chips are per-project. In the global tab we skip them — the
  // available-agents endpoint is scoped to a project and merging across
  // projects would just clutter the filter row.
  if (isGlobal.value) { agents.value = []; return; }
  const pid = activeProjectId.value;
  if (!pid) { agents.value = []; return; }
  try {
    agents.value = await fetchAvailableAgents(pid);
  } catch {
    // Non-fatal: the agent select just falls back to "Todos" without options.
    agents.value = [];
  }
}

async function load() {
  const pid = activeProjectId.value;
  if (!isGlobal.value && !pid) {
    executions.value = [];
    error.value = 'Selecciona un proyecto primero.';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    executions.value = await fetchExecutions({
      ...(isGlobal.value
        ? projectFilter.value.size > 0
          ? { projectId: Array.from(projectFilter.value) }
          : {}
        : { projectId: pid as string }),
      ...(agentFilter.value.size > 0 ? { agentId: Array.from(agentFilter.value) } : {}),
      ...(providerFilter.value.size > 0
        ? { providerId: Array.from(providerFilter.value) }
        : {}),
      ...(outcomeFilter.value.size > 0 ? { outcome: Array.from(outcomeFilter.value) } : {}),
      ...(fromFilter.value ? { from: fromFilter.value } : {}),
      ...(toFilter.value ? { to: toFilter.value } : {}),
      limit: limit.value,
    });
    // Accumulate discovered providers so chips remain visible after filtering.
    const nextDiscovered = new Set(discoveredProviders.value);
    for (const e of executions.value) if (e.providerId) nextDiscovered.add(e.providerId);
    if (nextDiscovered.size !== discoveredProviders.value.size) {
      discoveredProviders.value = nextDiscovered;
    }
  } catch (e) {
    // Axios throws Error subclasses with a descriptive `.message`; surface
    // that in the banner instead of console.error (see CLAUDE.md).
    error.value = e instanceof Error ? e.message : String(e);
    executions.value = [];
  } finally {
    loading.value = false;
  }
}

// ─── Related logs (tool calls + agent events) ─────────────────────────────
// The server-logs endpoint doesn't index by taskId, so we bound the query by
// the execution's time window and let the server return every log in that
// range, then filter client-side to entries whose `extras.taskId` matches.
// This is cheap enough for a per-expand fetch and avoids growing the API
// surface for a UI-only concern.
function runToIso(exec: ExecutionLog): string {
  if (exec.finishedAt) return exec.finishedAt;
  return new Date(Date.now() + OPEN_RUN_TO_MARGIN_MS).toISOString();
}

async function loadRelatedLogs(exec: ExecutionLog) {
  relatedLoading.value = { ...relatedLoading.value, [exec.id]: true };
  relatedError.value = { ...relatedError.value, [exec.id]: '' };
  try {
    const { entries } = await fetchServerLogs({
      from: exec.startedAt,
      to: runToIso(exec),
      limit: RELATED_LOGS_LIMIT,
      offset: 0,
      sort: 'asc',
    });
    // Newer runs stamp every log line with `runId === exec.id`. Fall back to
    // taskId for pre-migration executions where the correlation id didn't
    // exist yet.
    const forThisRun = entries.filter((e) => {
      const extras = e.extras;
      if (!extras) return false;
      if (extras.runId === exec.id) return true;
      if (!extras.runId && extras.taskId === exec.taskId) return true;
      return false;
    });
    relatedLogs.value = { ...relatedLogs.value, [exec.id]: forThisRun };
    fetchedRunIds.value = new Set([...fetchedRunIds.value, exec.id]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    relatedError.value = { ...relatedError.value, [exec.id]: msg };
  } finally {
    relatedLoading.value = { ...relatedLoading.value, [exec.id]: false };
  }
}

function reloadRelatedLogs(exec: ExecutionLog) {
  // Explicit refresh — clear the cache entry so `loadRelatedLogs` refetches
  // even if this exec has already been expanded once.
  const next = { ...relatedLogs.value };
  delete next[exec.id];
  relatedLogs.value = next;
  const nextFetched = new Set(fetchedRunIds.value);
  nextFetched.delete(exec.id);
  fetchedRunIds.value = nextFetched;
  void loadRelatedLogs(exec);
}

// Per-event expansion inside the related-logs list. Key format is
// `${exec.id}-${index}` so the same event across two open execs stays
// independent. Null = collapsed.
const expandedEventKey = ref<string | null>(null);
function toggleEvent(key: string) {
  expandedEventKey.value = expandedEventKey.value === key ? null : key;
}
function copyEventJson(entry: ServerLogEntry) {
  void navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
}

function toolFromExtras(entry: ServerLogEntry): string | null {
  const t = entry.extras?.tool;
  return typeof t === 'string' ? t : null;
}

function eventFromExtras(entry: ServerLogEntry): string | null {
  const ev = entry.extras?.event;
  return typeof ev === 'string' ? ev : null;
}

function isToolEvent(entry: ServerLogEntry): boolean {
  const ev = eventFromExtras(entry);
  return ev === 'tool.call' || ev === 'tool.result';
}

function toolUseIdFromExtras(entry: ServerLogEntry): string | null {
  const id = entry.extras?.toolUseId;
  return typeof id === 'string' ? id : null;
}

// A related-logs row is either a plain log entry (`other`) or a merged
// tool-call/tool-result pair matched by `toolUseId`. Pairing lets the drawer
// show request + response as one card instead of two separate rows.
type RelatedItem =
  | { kind: 'other'; key: string; entry: ServerLogEntry }
  | { kind: 'tool'; key: string; call: ServerLogEntry | null; result: ServerLogEntry | null };

function groupRelatedLogs(entries: ServerLogEntry[], execId: string): RelatedItem[] {
  const items: RelatedItem[] = [];
  const pending = new Map<string, Extract<RelatedItem, { kind: 'tool' }>>();
  let seq = 0;

  for (const entry of entries) {
    const ev = eventFromExtras(entry);
    const id = toolUseIdFromExtras(entry);

    if ((ev === 'tool.call' || ev === 'tool.result') && id) {
      const existing = pending.get(id);
      if (existing) {
        if (ev === 'tool.call') existing.call = entry;
        else existing.result = entry;
        // Keep in the map so a stray duplicate would still land here, but
        // once both halves are set we won't overwrite them accidentally.
        continue;
      }
      const group: Extract<RelatedItem, { kind: 'tool' }> = {
        kind: 'tool',
        key: `${execId}-t-${id}`,
        call: ev === 'tool.call' ? entry : null,
        result: ev === 'tool.result' ? entry : null,
      };
      pending.set(id, group);
      items.push(group);
      continue;
    }

    // Non-tool events (or pre-migration entries without toolUseId) pass
    // through as their own row.
    items.push({ kind: 'other', key: `${execId}-o-${seq++}-${entry.time}`, entry });
  }

  return items;
}

const pairedRelatedLogs = computed<Record<string, RelatedItem[]>>(() => {
  const out: Record<string, RelatedItem[]> = {};
  for (const [execId, entries] of Object.entries(relatedLogs.value)) {
    out[execId] = groupRelatedLogs(entries, execId);
  }
  return out;
});

function headerEntryFor(item: Extract<RelatedItem, { kind: 'tool' }>): ServerLogEntry | null {
  return item.call ?? item.result;
}

// ─── Autoscroll ───────────────────────────────────────────────────────────
// The drawer body is the actual scroll container (the ul itself doesn't
// overflow), so we pin *its* scrollTop to the bottom as new entries stream
// in — unless the user scrolled up to read something. Threshold of 40px
// keeps small rendering bounces from flipping the flag.
const drawerBodyEl = ref<HTMLDivElement | null>(null);
const autoScroll = ref(true);
const AUTOSCROLL_STICK_THRESHOLD_PX = 40;

function onDrawerScroll() {
  const el = drawerBodyEl.value;
  if (!el) return;
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  autoScroll.value = distFromBottom <= AUTOSCROLL_STICK_THRESHOLD_PX;
}
function scrollRelatedToBottom() {
  const el = drawerBodyEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

// ─── Row expansion ────────────────────────────────────────────────────────
// Tracks runIds that have been reconciled with `daemon.log` at least once.
// Live mode primes an empty buffer for every new in-flight run so log:entry
// events can stream in immediately, but that prime isn't the same as "the
// user has seen the historical entries yet" — hence this separate set.
const fetchedRunIds = ref<Set<string>>(new Set());
// Per-execution pause. When present the log:entry handler drops events for
// that runId so the reader can inspect a snapshot without new rows shifting
// underneath. Resuming refetches from `daemon.log` to catch up on what was
// missed while paused.
const pausedRunIds = ref<Set<string>>(new Set());

function toggleRow(id: string) {
  const opening = expandedId.value !== id;
  expandedId.value = opening ? id : null;
  if (opening) {
    const exec = executions.value.find((e) => e.id === id);
    // On first open, hit the file to backfill anything that landed before
    // the drawer existed. Subsequent opens reuse the in-memory buffer,
    // which live mode keeps growing via WS.
    if (exec && !fetchedRunIds.value.has(exec.id)) {
      void loadRelatedLogs(exec);
    }
    // Reset autoscroll so the newly-opened drawer starts pinned to bottom.
    autoScroll.value = true;
  }
}

function isPaused(runId: string): boolean {
  return pausedRunIds.value.has(runId);
}
function togglePause(exec: ExecutionLog) {
  const next = new Set(pausedRunIds.value);
  if (next.has(exec.id)) {
    next.delete(exec.id);
    pausedRunIds.value = next;
    // Resuming: refetch so any events dropped while paused are visible.
    void loadRelatedLogs(exec);
  } else {
    next.add(exec.id);
    pausedRunIds.value = next;
  }
}

// Right-side drawer state derived from expandedId. selectedExec === null
// means the drawer is closed.
const selectedExec = computed(() =>
  expandedId.value ? (executions.value.find((e) => e.id === expandedId.value) ?? null) : null,
);
function closeDetail() {
  expandedId.value = null;
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && expandedId.value !== null) closeDetail();
}

function loadMore() {
  limit.value += LIMIT_STEP;
  // limit is a server-side filter; the watcher below will fire load().
}

// Copy the full ExecutionLog JSON to the clipboard. `navigator.clipboard`
// needs a secure context (HTTPS or localhost), which matches our dev setup.
function copyJson(exec: ExecutionLog) {
  void navigator.clipboard.writeText(JSON.stringify(exec, null, 2));
}

// Formatters — kept as plain functions so the template stays declarative.
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : now.value;
  if (Number.isNaN(start) || Number.isNaN(end)) return '—';
  const ms = end - start;
  if (ms < 0) return '—';
  const suffix = finishedAt ? '' : '…';
  if (ms < 1000) return `${ms} ms${suffix}`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s${suffix}`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSec}s${suffix}`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m${suffix}`;
}

function outcomeColor(outcome: ExecutionLog['outcome']): { bg: string; fg: string } {
  switch (outcome) {
    case 'success':   return { bg: 'var(--accent)', fg: 'var(--panel)' };
    case 'error':     return { bg: 'var(--danger)', fg: 'var(--panel)' };
    case 'cancelled': return { bg: 'var(--fg-dim)', fg: 'var(--panel)' };
    case 'truncated': return { bg: 'var(--warn)', fg: 'var(--panel)' };
    default:          return { bg: 'var(--border)', fg: 'var(--fg-mute)' };
  }
}

function outcomeLabel(outcome: ExecutionLog['outcome']): string {
  return outcome ?? 'pending';
}

// Same palette used by ServerLogsSection — kept in sync so a log's level
// looks identical whether it's rendered in the Logs tab or the exec detail.
function levelColor(level: ServerLogLevel): { bg: string; fg: string } {
  switch (level) {
    case 'trace': return { bg: 'var(--fg-dim)', fg: 'var(--panel)' };
    case 'debug': return { bg: 'var(--info)', fg: 'var(--accent)' };
    case 'info':  return { bg: 'var(--accent)', fg: 'var(--panel)' };
    case 'warn':  return { bg: 'var(--warn)', fg: 'var(--panel)' };
    case 'error': return { bg: 'var(--danger)', fg: 'var(--panel)' };
    case 'fatal': return { bg: 'var(--danger)', fg: 'var(--panel)' };
  }
}

const REL_MSG_TRUNCATE = 140;
function truncateMsg(msg: string): string {
  return msg.length > REL_MSG_TRUNCATE ? `${msg.slice(0, REL_MSG_TRUNCATE)}…` : msg;
}

// Autoscroll watcher: whenever the visible drawer's related-logs array grows
// and the reader hasn't scrolled up, pin the list to the bottom on next tick
// so the newest entry is in view.
watch(
  () => {
    const exec = selectedExec.value;
    if (!exec) return 0;
    return relatedLogs.value[exec.id]?.length ?? 0;
  },
  async () => {
    if (!autoScroll.value) return;
    await nextTick();
    scrollRelatedToBottom();
  },
);

// Live-elapsed ticker: 1Hz interval, only alive while ≥1 execution is still
// open. Avoids a permanent timer on a page that's usually all-finished rows.
const hasOpenExecutions = computed(() => executions.value.some((e) => !e.finishedAt));
let nowTimer: ReturnType<typeof setInterval> | null = null;
watch(
  hasOpenExecutions,
  (has) => {
    if (has && nowTimer === null) {
      now.value = Date.now();
      nowTimer = setInterval(() => { now.value = Date.now(); }, 1000);
    } else if (!has && nowTimer !== null) {
      clearInterval(nowTimer);
      nowTimer = null;
    }
  },
  { immediate: true },
);

// ─── Live mode ─────────────────────────────────────────────────────────────
// Subscribes to the shared server WS and merges execution:* / log:entry
// events into local state so the list, drawer, and per-run tool cards
// refresh without a manual reload. Defaults on; user can disable if the
// stream ever gets in the way.
const liveMode = ref(true);
const { connected: liveConnected } = useServerEvents((msg) => {
  if (!liveMode.value) return;

  if (msg.type === 'execution:started' || msg.type === 'execution:updated') {
    const parsed = ExecutionLogSchema.safeParse((msg as { log: unknown }).log);
    if (!parsed.success) return;
    const log = parsed.data;
    // Scope live events. In project mode: only the active project. In global
    // mode: respect the projectFilter chip set (empty = todos).
    if (isGlobal.value) {
      if (projectFilter.value.size > 0 && !projectFilter.value.has(log.projectId)) return;
    } else if (activeProjectId.value && log.projectId !== activeProjectId.value) {
      return;
    }

    if (msg.type === 'execution:started') {
      // Grow the provider chip row so newly-seen providers appear as filters.
      discoveredProviders.value = new Set([...discoveredProviders.value, log.providerId]);
      const idx = executions.value.findIndex((e) => e.id === log.id);
      if (idx === -1) executions.value = [log, ...executions.value];
      else executions.value = executions.value.map((e) => (e.id === log.id ? log : e));
      // Auto-prime an empty buffer for the new in-flight run so subsequent
      // log:entry events land somewhere even before the drawer is opened.
      if (!(log.id in relatedLogs.value)) {
        relatedLogs.value = { ...relatedLogs.value, [log.id]: [] };
      }
    } else {
      executions.value = executions.value.map((e) => (e.id === log.id ? log : e));
    }
    return;
  }

  if (msg.type === 'log:entry') {
    const parsed = ServerLogEntrySchema.safeParse((msg as { entry: unknown }).entry);
    if (!parsed.success) return;
    const entry = parsed.data;
    const runId = entry.extras?.runId;
    if (typeof runId !== 'string') return;
    // Merge only when we already track this run — either the drawer opened
    // once (fetched from disk) or execution:started primed an empty buffer.
    if (!(runId in relatedLogs.value)) return;
    // Per-run pause: drop live events until the reader resumes. On resume
    // loadRelatedLogs is called to catch up on the dropped window.
    if (pausedRunIds.value.has(runId)) return;
    relatedLogs.value = {
      ...relatedLogs.value,
      [runId]: [...relatedLogs.value[runId], entry],
    };
  }
});

onMounted(() => {
  void loadAgents();
  void loadIssueUrlMap();
  void load();
  window.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  if (nowTimer !== null) {
    clearInterval(nowTimer);
    nowTimer = null;
  }
});

// Reload when the active project changes — same pattern as StatusesSection.
// In global scope the active project is irrelevant, so skip.
watch(activeProjectId, () => {
  if (isGlobal.value) return;
  // Reset filters that don't make sense across projects.
  agentFilter.value = new Set();
  providerFilter.value = new Set();
  outcomeFilter.value = new Set();
  expandedId.value = null;
  limit.value = DEFAULT_LIMIT;
  discoveredProviders.value = new Set();
  relatedLogs.value = {};
  relatedLoading.value = {};
  relatedError.value = {};
  fetchedRunIds.value = new Set();
  pausedRunIds.value = new Set();
  autoScroll.value = true;
  issueUrlByTaskId.value = {};
  void loadAgents();
  void loadIssueUrlMap();
  void load();
});

// Server-side filters: refetch on change. `immediate: false` (the default)
// keeps the initial load in onMounted from double-firing.
watch(
  [agentFilter, providerFilter, outcomeFilter, fromFilter, toFilter, limit, projectFilter],
  () => { void load(); },
);
</script>

<template>
  <section class="settings-section">
    <div class="section-header">
      <div>
        <h2>Ejecuciones</h2>
        <p class="section-desc">
          Historial de agentes ejecutados sobre las tareas de este proyecto.
          Los filtros de agente, outcome y fechas se aplican en el servidor.
        </p>
      </div>
      <div class="header-actions">
        <button
          type="button"
          class="live-toggle"
          :class="{
            'live-toggle--on': liveMode && liveConnected,
            'live-toggle--pending': liveMode && !liveConnected,
          }"
          :aria-pressed="liveMode"
          :title="
            liveMode
              ? liveConnected
                ? 'Live: recibiendo eventos en tiempo real'
                : 'Live: intentando reconectar…'
              : 'Live desactivado — los cambios sólo aparecen al recargar'
          "
          @click="liveMode = !liveMode"
        >
          <span class="live-dot" aria-hidden="true"></span>
          Live
        </button>
        <button
          type="button"
          class="btn-primary"
          :disabled="loading"
          @click="load()"
        >
          {{ loading ? 'Cargando…' : '↺ Actualizar' }}
        </button>
      </div>
    </div>

    <div class="filters">
      <div class="filter-row">
        <label class="filter">
          <span>Desde</span>
          <input type="date" v-model="fromFilter" />
        </label>

        <label class="filter">
          <span>Hasta</span>
          <input type="date" v-model="toFilter" />
        </label>

        <label class="filter filter--grow">
          <span>Tarea</span>
          <input
            type="text"
            v-model="taskTextInput"
            placeholder="Filtrar por título o taskId…"
          />
        </label>
      </div>

      <div v-if="isGlobal && allProjects.length > 0" class="filter filter--chips">
        <span class="filter-label">
          Proyectos
          <span class="filter-hint">
            {{ projectFilter.size > 0
              ? `${projectFilter.size}/${allProjects.length} activos`
              : `todos (${allProjects.length})` }}
          </span>
        </span>
        <div class="chips">
          <button
            v-for="p in allProjects"
            :key="p.id"
            type="button"
            class="chip chip--project"
            :class="{ 'chip--active': projectFilter.size === 0 || projectFilter.has(p.id) }"
            :aria-pressed="projectFilter.has(p.id)"
            :data-testid="`executions-filter-project-chip-${p.id}`"
            @click="projectFilter = toggleInSet(projectFilter, p.id)"
          >{{ p.name }}</button>
        </div>
      </div>

      <div v-if="agents.length > 0" class="filter filter--chips">
        <span class="filter-label">
          Agentes
          <span class="filter-hint">
            {{ agentFilter.size > 0
              ? `${agentFilter.size}/${agents.length} activos`
              : `todos (${agents.length})` }}
          </span>
        </span>
        <div class="chips">
          <button
            v-for="a in agents"
            :key="a.id"
            type="button"
            class="chip chip--agent"
            :class="{ 'chip--active': agentFilter.size === 0 || agentFilter.has(a.id) }"
            :aria-pressed="agentFilter.has(a.id)"
            :data-testid="`executions-filter-agent-chip-${a.id}`"
            @click="agentFilter = toggleInSet(agentFilter, a.id)"
          >{{ a.id }}</button>
        </div>
      </div>

      <div v-if="providers.length > 0" class="filter filter--chips">
        <span class="filter-label">
          Providers
          <span class="filter-hint">
            {{ providerFilter.size > 0
              ? `${providerFilter.size}/${providers.length} activos`
              : `todos (${providers.length})` }}
          </span>
        </span>
        <div class="chips">
          <button
            v-for="p in providers"
            :key="p"
            type="button"
            class="chip chip--provider"
            :class="{ 'chip--active': providerFilter.size === 0 || providerFilter.has(p) }"
            :aria-pressed="providerFilter.has(p)"
            :data-testid="`executions-filter-provider-chip-${p}`"
            @click="providerFilter = toggleInSet(providerFilter, p)"
          >{{ p }}</button>
        </div>
      </div>
    </div>

    <div v-if="error" class="items-error">{{ error }}</div>

    <div class="exec-summary" aria-label="Resumen por outcome">
      <span class="exec-summary__total">{{ executions.length }} ejecuciones</span>
      <button
        v-for="oc in OUTCOME_ORDER"
        :key="oc"
        type="button"
        class="exec-summary__chip"
        :class="[
          `exec-summary__chip--${oc}`,
          { 'exec-summary__chip--zero': outcomeCounts[oc] === 0 },
        ]"
        :aria-pressed="oc !== 'pending' && outcomeFilter.has(oc as OutcomeValue)"
        :data-testid="`executions-summary-${oc}`"
        @click="selectSummaryOutcome(oc)"
      >
        {{ oc }} <b>{{ outcomeCounts[oc] }}</b>
      </button>
    </div>

    <div class="exec-list-wrapper">
      <div class="exec-list-header" role="row">
        <button
          type="button"
          class="exec-title exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'taskTitle' }"
          @click="selectExecColumn('taskTitle')"
        >Título{{ execSortArrow('taskTitle') }}</button>
        <button
          type="button"
          class="exec-meta exec-agent exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'agentId' }"
          @click="selectExecColumn('agentId')"
        >Agente{{ execSortArrow('agentId') }}</button>
        <button
          type="button"
          class="exec-meta exec-provider exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'providerId' }"
          @click="selectExecColumn('providerId')"
        >Provider{{ execSortArrow('providerId') }}</button>
        <button
          type="button"
          class="exec-meta exec-date exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'startedAt' }"
          @click="selectExecColumn('startedAt')"
        >Fecha{{ execSortArrow('startedAt') }}</button>
        <button
          type="button"
          class="exec-meta exec-duration exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'duration' }"
          @click="selectExecColumn('duration')"
        >Duración{{ execSortArrow('duration') }}</button>
        <button
          type="button"
          class="exec-outcome-col exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'outcome' }"
          @click="selectExecColumn('outcome')"
        >Outcome{{ execSortArrow('outcome') }}</button>
        <span class="exec-chevron"></span>
      </div>

      <p v-if="loading && !executions.length" class="exec-empty">Cargando ejecuciones…</p>
      <p v-else-if="!filteredExecutions.length" class="exec-empty">
        No hay ejecuciones para los filtros actuales.
      </p>

      <ul v-else class="exec-list">
        <li
          v-for="exec in sortedExecutions"
          :key="exec.id"
          class="exec-card"
          :class="{ 'exec-card--open': expandedId === exec.id }"
        >
          <button
            type="button"
            class="exec-row"
            @click="toggleRow(exec.id)"
            :aria-expanded="expandedId === exec.id"
          >
            <span
              v-if="isGlobal"
              class="exec-project-tag"
              :title="`Proyecto: ${projectNameFor(exec.projectId)}`"
            >{{ projectNameFor(exec.projectId) }}</span>
            <span class="exec-title">
              <a
                v-if="issueUrlFor(exec.taskId)"
                :href="issueUrlFor(exec.taskId)!"
                target="_blank"
                rel="noopener noreferrer"
                @click.stop
              >{{ exec.taskTitle }} ↗</a>
              <template v-else>{{ exec.taskTitle }}</template>
            </span>
            <span class="exec-meta exec-agent">{{ exec.agentId }}</span>
            <span class="exec-meta exec-provider">{{ exec.providerId }}</span>
            <span class="exec-meta exec-date" :title="exec.startedAt">{{ formatDateCompact(exec.startedAt) }}</span>
            <span class="exec-meta exec-duration">{{ formatDuration(exec.startedAt, exec.finishedAt) }}</span>
            <span
              class="exec-outcome"
              :style="{
                background: outcomeColor(exec.outcome).bg,
                color: outcomeColor(exec.outcome).fg,
              }"
            >{{ outcomeLabel(exec.outcome) }}</span>
            <span class="exec-chevron" aria-hidden="true">›</span>
          </button>
        </li>
      </ul>
    </div>

    <div v-if="executions.length === limit" class="load-more">
      <button type="button" class="btn-secondary" :disabled="loading" @click="loadMore()">
        Cargar más
      </button>
    </div>

    <!-- Right-side detail drawer -->
    <transition name="exec-drawer">
      <aside
        v-if="selectedExec"
        class="exec-drawer"
        role="dialog"
        aria-label="Detalle de la ejecución"
        data-testid="executions-detail-drawer"
      >
        <header class="exec-drawer__header">
          <div class="exec-drawer__title">
            <h3>Ejecución</h3>
            <span
              class="exec-outcome"
              :style="{
                background: outcomeColor(selectedExec.outcome).bg,
                color: outcomeColor(selectedExec.outcome).fg,
              }"
            >{{ outcomeLabel(selectedExec.outcome) }}</span>
          </div>
          <button
            type="button"
            class="exec-drawer__close"
            aria-label="Cerrar detalle"
            data-testid="executions-detail-close"
            @click="closeDetail()"
          >×</button>
        </header>

        <div
          ref="drawerBodyEl"
          class="exec-drawer__body"
          @scroll.passive="onDrawerScroll"
        >
          <p class="exec-drawer__task">
            <a
              v-if="issueUrlFor(selectedExec.taskId)"
              :href="issueUrlFor(selectedExec.taskId)!"
              target="_blank"
              rel="noopener noreferrer"
            >{{ selectedExec.taskTitle }} ↗</a>
            <template v-else>{{ selectedExec.taskTitle }}</template>
          </p>

          <div class="detail-row">
            <span class="detail-label">taskId</span>
            <code class="detail-value">{{ selectedExec.taskId }}</code>
          </div>
          <div class="detail-row">
            <span class="detail-label">agentId</span>
            <code class="detail-value">{{ selectedExec.agentId }}</code>
          </div>
          <div class="detail-row">
            <span class="detail-label">providerId</span>
            <code class="detail-value">{{ selectedExec.providerId }}</code>
          </div>
          <div v-if="selectedExec.errorMsg" class="detail-row">
            <span class="detail-label">errorMsg</span>
            <pre class="detail-value detail-value--pre">{{ selectedExec.errorMsg }}</pre>
          </div>
          <div v-if="selectedExec.stopReason" class="detail-row">
            <span class="detail-label">stopReason</span>
            <code class="detail-value">{{ selectedExec.stopReason }}</code>
          </div>
          <div class="detail-row">
            <span class="detail-label">startedAt</span>
            <code class="detail-value" :title="selectedExec.startedAt">{{ formatDate(selectedExec.startedAt) }}</code>
          </div>
          <div class="detail-row">
            <span class="detail-label">finishedAt</span>
            <code class="detail-value" :title="selectedExec.finishedAt ?? ''">{{ selectedExec.finishedAt ? formatDate(selectedExec.finishedAt) : '—' }}</code>
          </div>

          <div class="detail-json-block">
            <div class="detail-json-header">
              <span class="detail-label">JSON completo</span>
              <button
                type="button"
                class="btn-copy"
                data-testid="executions-copy-json"
                @click="copyJson(selectedExec)"
              >
                Copiar JSON
              </button>
            </div>
            <pre class="detail-json">{{ JSON.stringify(selectedExec, null, 2) }}</pre>
          </div>

          <div class="related-block">
            <div class="related-header">
              <span class="detail-label">
                Tool calls y eventos del servidor
                <span
                  v-if="relatedLogs[selectedExec.id]"
                  class="related-count"
                >({{ relatedLogs[selectedExec.id].length }})</span>
              </span>
              <div class="related-actions">
                <button
                  v-if="liveMode"
                  type="button"
                  class="btn-copy pause-btn"
                  :class="{ 'pause-btn--paused': isPaused(selectedExec.id) }"
                  :title="
                    isPaused(selectedExec.id)
                      ? 'Reanudar el stream de logs para esta ejecución'
                      : 'Pausar el stream de logs (se refetch al reanudar)'
                  "
                  @click="togglePause(selectedExec)"
                >
                  {{ isPaused(selectedExec.id) ? '▶ Reanudar' : '⏸ Pausar' }}
                </button>
                <button
                  type="button"
                  class="btn-copy"
                  data-testid="executions-related-refresh"
                  :disabled="relatedLoading[selectedExec.id]"
                  @click="reloadRelatedLogs(selectedExec)"
                >
                  ↻ Recargar
                </button>
                <button
                  type="button"
                  class="btn-copy"
                  data-testid="executions-related-open-logs"
                  @click="openRunInLogs(selectedExec)"
                >
                  Ir a Logs →
                </button>
              </div>
            </div>

            <div v-if="relatedLoading[selectedExec.id]" class="related-empty">
              Cargando logs relacionados…
            </div>
            <div v-else-if="relatedError[selectedExec.id]" class="items-error related-error">
              {{ relatedError[selectedExec.id] }}
            </div>
            <div
              v-else-if="relatedLogs[selectedExec.id] && relatedLogs[selectedExec.id].length === 0"
              class="related-empty"
            >
              No se encontraron entradas en <code>daemon.log</code> para esta ejecución.
              Los agentes async (tmux/iterm) no emiten <code>tool.call</code>/<code>tool.result</code>
              — sus tool calls quedan registrados por Claude Code, no por el daemon.
            </div>
            <div v-else-if="relatedLogs[selectedExec.id]" class="related-list-wrap">
              <button
                v-if="!autoScroll"
                type="button"
                class="autoscroll-hint"
                title="Volver al final y reanudar autoscroll"
                @click="() => { autoScroll = true; scrollRelatedToBottom(); }"
              >
                ↓ Ir al final (autoscroll pausado)
              </button>
              <ul
                class="related-list"
                data-testid="executions-related-list"
              >
              <template v-for="item in pairedRelatedLogs[selectedExec.id]" :key="item.key">
                <!-- Non-tool events: keep the original single-entry card -->
                <li
                  v-if="item.kind === 'other'"
                  class="related-card"
                  :class="{ 'related-card--open': expandedEventKey === item.key }"
                >
                  <button
                    type="button"
                    class="related-row"
                    :aria-expanded="expandedEventKey === item.key"
                    @click="toggleEvent(item.key)"
                  >
                    <span class="related-time">{{ formatTime(item.entry.time) }}</span>
                    <span
                      class="related-level"
                      :style="{
                        background: levelColor(item.entry.level).bg,
                        color: levelColor(item.entry.level).fg,
                      }"
                    >{{ item.entry.level }}</span>
                    <span v-if="eventFromExtras(item.entry)" class="related-event">
                      {{ eventFromExtras(item.entry) }}
                    </span>
                    <span class="related-msg">{{ truncateMsg(item.entry.msg) }}</span>
                    <span class="related-chevron" aria-hidden="true">
                      {{ expandedEventKey === item.key ? '▾' : '▸' }}
                    </span>
                  </button>
                  <div v-if="expandedEventKey === item.key" class="related-detail">
                    <div class="related-detail-header">
                      <span class="detail-label">JSON completo del evento</span>
                      <button
                        type="button"
                        class="btn-copy"
                        data-testid="executions-related-copy-json"
                        @click="copyEventJson(item.entry)"
                      >
                        Copiar JSON
                      </button>
                    </div>
                    <pre class="related-detail-json">{{ JSON.stringify(item.entry, null, 2) }}</pre>
                  </div>
                </li>

                <!-- Tool call + result merged into a single card -->
                <li
                  v-else
                  class="related-card related-card--tool"
                  :class="{ 'related-card--open': expandedEventKey === item.key }"
                >
                  <button
                    type="button"
                    class="related-row"
                    :aria-expanded="expandedEventKey === item.key"
                    @click="toggleEvent(item.key)"
                  >
                    <span class="related-time">
                      {{ formatTime((headerEntryFor(item) as any).time) }}
                    </span>
                    <span
                      class="related-level"
                      :style="{
                        background: levelColor((headerEntryFor(item) as any).level).bg,
                        color: levelColor((headerEntryFor(item) as any).level).fg,
                      }"
                    >{{ (headerEntryFor(item) as any).level }}</span>
                    <span class="related-tool">
                      <span
                        class="related-tool-tag"
                        :class="{
                          'related-tool-tag--pending': !item.result,
                          'related-tool-tag--orphan': !item.call,
                        }"
                        :title="
                          item.call && item.result
                            ? 'request + response'
                            : item.call
                              ? 'esperando response…'
                              : 'response sin request registrado'
                        "
                      >
                        {{ item.call && item.result ? 'tool' : item.call ? 'call' : 'result' }}
                      </span>
                      <code class="related-tool-name">
                        {{ toolFromExtras(headerEntryFor(item) as any) }}
                      </code>
                    </span>
                    <span class="related-msg">
                      {{ truncateMsg((headerEntryFor(item) as any).msg) }}
                    </span>
                    <span class="related-chevron" aria-hidden="true">
                      {{ expandedEventKey === item.key ? '▾' : '▸' }}
                    </span>
                  </button>

                  <div v-if="expandedEventKey === item.key" class="related-detail">
                    <div v-if="item.call" class="related-detail-section">
                      <div class="related-detail-header">
                        <span class="detail-label">Request (tool.call)</span>
                        <button
                          type="button"
                          class="btn-copy"
                          @click="copyEventJson(item.call)"
                        >
                          Copiar JSON
                        </button>
                      </div>
                      <pre class="related-detail-json">{{ JSON.stringify(item.call, null, 2) }}</pre>
                    </div>
                    <div v-if="item.result" class="related-detail-section">
                      <div class="related-detail-header">
                        <span class="detail-label">Response (tool.result)</span>
                        <button
                          type="button"
                          class="btn-copy"
                          @click="copyEventJson(item.result)"
                        >
                          Copiar JSON
                        </button>
                      </div>
                      <pre class="related-detail-json">{{ JSON.stringify(item.result, null, 2) }}</pre>
                    </div>
                    <div v-if="!item.result" class="related-detail-note">
                      Aún no se registra el <code>tool.result</code> — el tool está corriendo o
                      la ejecución terminó antes de emitirlo.
                    </div>
                  </div>
                </li>
              </template>
            </ul>
            </div>
          </div>
        </div>
      </aside>
    </transition>
  </section>
</template>

<style scoped>
.settings-section { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: 0.82rem; color: var(--fg-dim); line-height: 1.5; }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }
.header-actions { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
.live-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.7rem;
  background: var(--panel-hi);
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.8rem;
  color: var(--fg-dim);
  cursor: pointer;
  transition: background 120ms, color 120ms, border-color 120ms;
}
.live-toggle:hover { background: var(--border); }
.live-toggle--on { background: var(--green-bg); border-color: var(--accent); color: var(--accent); }
.live-toggle--pending { background: var(--yellow-bg); border-color: var(--warn); color: var(--warn); }
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-dim);
  flex-shrink: 0;
}
.live-toggle--on .live-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2);
  animation: live-pulse 1.6s ease-in-out infinite;
}
.live-toggle--pending .live-dot { background: var(--warn); animation: live-pulse 1.6s ease-in-out infinite; }
@keyframes live-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.45; }
}
.section-header h2 { margin: 0 0 0.2rem; font-size: 1.05rem; }

.btn-primary {
  flex-shrink: 0;
  padding: 0.35rem 0.8rem;
  background: var(--accent);
  color: var(--panel);
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.btn-primary:hover { background: var(--accent); }
.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

.btn-secondary {
  padding: 0.4rem 0.85rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  background: var(--panel);
  font-size: 0.85rem;
  color: var(--fg-mute);
  cursor: pointer;
}
.btn-secondary:hover { background: var(--panel-hi); }
.btn-secondary:disabled { opacity: 0.6; cursor: not-allowed; }

.btn-copy {
  padding: 0.25rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 5px;
  background: var(--panel);
  font-size: 0.75rem;
  color: var(--fg-mute);
  cursor: pointer;
}
.btn-copy:hover { background: var(--panel-hi); }
.btn-copy:disabled { opacity: 0.6; cursor: not-allowed; }

.filters {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.65rem 0.75rem;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 0.85rem;
}
.filter-row { display: flex; flex-wrap: wrap; gap: 0.6rem; }
.filter { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.78rem; color: var(--fg-mute); min-width: 130px; }
.filter--grow { flex: 1; min-width: 200px; }
.filter--chips { gap: 0.3rem; }
.filter-label { font-weight: 500; color: var(--fg-dim); font-size: 0.78rem; }
.filter-hint { font-weight: 400; color: var(--fg-dim); margin-left: 0.25rem; font-size: 0.72rem; }
.filter span { font-weight: 500; color: var(--fg-dim); }
.filter select, .filter input {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border-hi);
  border-radius: 5px;
  font-size: 0.85rem;
  background: var(--panel);
  color: var(--fg);
}

.chips { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
.chip {
  padding: 0.2rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 999px;
  background: var(--panel);
  color: var(--fg-mute);
  font-size: 0.75rem;
  line-height: 1.2;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.chip:hover { background: var(--panel-hi); }
.chip--active { font-weight: 600; background: var(--fg); color: var(--panel); border-color: var(--fg); }
.chip--agent {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  color: var(--info);
  border-color: var(--info);
  background: var(--panel-hi);
}
.chip--agent:hover { background: var(--panel-hi); }
.chip--agent.chip--active {
  background: var(--info);
  color: var(--panel);
  border-color: var(--info);
}
.chip--project {
  font-size: 0.72rem;
  color: var(--warn);
  border-color: var(--warn);
  background: var(--yellow-bg);
}
.chip--project:hover { background: var(--yellow-bg); }
.chip--project.chip--active {
  background: var(--warn);
  color: var(--panel);
  border-color: var(--warn);
}
.chip--provider {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  color: var(--info);
  border-color: var(--info);
  background: var(--panel-hi);
}
.chip--provider:hover { background: var(--info); }
.chip--provider.chip--active {
  background: var(--info);
  color: var(--panel);
  border-color: var(--info);
}

.empty { font-size: 0.875rem; color: var(--fg-dim); padding: 0.5rem 0; }
.items-error {
  padding: 0.6rem 0.85rem;
  background: var(--red-bg);
  border: 1px solid var(--danger);
  border-radius: 6px;
  font-size: 0.82rem;
  color: var(--danger);
  margin-bottom: 0.75rem;
}

/* ─── Summary row (outcome counts) ─────────────────────────────────── */
.exec-summary {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.6rem;
  margin-bottom: 0.5rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.75rem;
  flex-wrap: wrap;
}
.exec-summary__total { color: var(--fg-dim); margin-right: 0.4rem; }
.exec-summary__chip {
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  border: 1px solid transparent;
  cursor: pointer;
  font-size: 0.72rem;
  text-transform: lowercase;
  line-height: 1.2;
  transition: transform 0.08s ease;
}
.exec-summary__chip b { margin-left: 0.25rem; font-weight: 700; }
.exec-summary__chip:hover { transform: translateY(-1px); }
.exec-summary__chip[aria-pressed='true'] { outline: 2px solid var(--fg); outline-offset: 1px; }
.exec-summary__chip--success   { background: transparent; color: var(--accent); border-color: var(--border); }
.exec-summary__chip--error     { background: transparent; color: var(--danger); border-color: var(--border); }
.exec-summary__chip--cancelled { background: transparent; color: var(--fg-mute); border-color: var(--border); }
.exec-summary__chip--truncated { background: transparent; color: var(--warn); border-color: var(--border); }
.exec-summary__chip--pending   { background: transparent; color: var(--fg-dim); border-color: var(--border); cursor: default; }
.exec-summary__chip--zero { opacity: 0.4; }
.exec-summary__chip--zero:hover { opacity: 0.7; }

/* ─── Table wrapper + sticky sortable header ───────────────────────── */
.exec-list-wrapper { position: relative; }
.exec-list-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0.85rem;
  background: var(--panel-hi);
  border: 1px solid var(--border);
  border-radius: 6px 6px 0 0;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  position: sticky;
  top: 0;
  z-index: 1;
}
.exec-header-btn {
  background: none;
  border: none;
  padding: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.exec-header-btn:hover { color: var(--fg); }
.exec-header-btn--active { color: var(--fg); }
.exec-list-header .exec-outcome-col {
  flex-shrink: 0;
  width: 90px;
  text-align: center;
}
.exec-empty {
  padding: 1.5rem 0.75rem;
  text-align: center;
  color: var(--fg-dim);
  font-size: 0.85rem;
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 6px 6px;
  margin: 0;
}

.exec-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.exec-card {
  border: 1px solid var(--border);
  border-top: none;
  background: var(--panel);
  overflow: hidden;
}
.exec-card:last-child { border-radius: 0 0 6px 6px; }
.exec-card--open { border-color: var(--info); background: var(--panel-hi); box-shadow: inset 3px 0 0 var(--accent); }

/* ─── Right-side detail drawer ───────────────────────────────────────── */
.exec-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 60vw;
  min-width: 420px;
  background: var(--panel);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 24px rgba(15, 23, 42, 0.08);
  display: flex;
  flex-direction: column;
  z-index: 40;
}
.exec-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--panel-alt);
}
.exec-drawer__title {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}
.exec-drawer__title h3 { margin: 0; font-size: 1rem; color: var(--fg); }
.exec-drawer__close {
  padding: 0.15rem 0.55rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  background: var(--panel);
  color: var(--fg-mute);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
}
.exec-drawer__close:hover { background: var(--panel-hi); color: var(--fg); }
.exec-drawer__body {
  flex: 1;
  overflow: auto;
  padding: 0.85rem 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.exec-drawer__task {
  margin: 0 0 0.4rem;
  font-weight: 500;
  color: var(--fg);
  font-size: 0.95rem;
}
.exec-drawer__task a { color: var(--accent); text-decoration: none; }
.exec-drawer__task a:hover { text-decoration: underline; }

.exec-drawer-enter-active,
.exec-drawer-leave-active { transition: transform 0.18s ease, opacity 0.18s ease; }
.exec-drawer-enter-from,
.exec-drawer-leave-to { transform: translateX(100%); opacity: 0; }

.exec-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.6rem 0.85rem;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 0.85rem;
  color: var(--fg);
}
.exec-row:hover { background: var(--panel-alt); }
.exec-title { flex: 1; min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.exec-title a { color: var(--accent); text-decoration: none; }
.exec-title a:hover { text-decoration: underline; }
/* Fixed column widths so header cells and row cells line up regardless of
   content length. Longest realistic values: agent ~"ia-flow-implementer-api"
   (23ch), provider "anthropic-api" (13ch), date "10 ago 21:11:44" (15ch). */
.exec-meta {
  font-size: 0.75rem;
  color: var(--fg-dim);
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.exec-project-tag {
  flex-shrink: 0;
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  background: var(--yellow-bg);
  color: var(--warn);
  border: 1px solid var(--warn);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.exec-agent { font-family: 'SF Mono', 'Fira Code', monospace; color: var(--info); width: 180px; }
.exec-provider { font-family: 'SF Mono', 'Fira Code', monospace; width: 120px; }
.exec-date { font-variant-numeric: tabular-nums; width: 120px; font-family: 'SF Mono', 'Fira Code', monospace; }
.exec-duration { font-variant-numeric: tabular-nums; width: 70px; text-align: right; font-family: 'SF Mono', 'Fira Code', monospace; }
.exec-outcome {
  flex-shrink: 0;
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
  text-transform: lowercase;
  width: 90px;
  text-align: center;
  box-sizing: border-box;
}
.exec-chevron { color: var(--fg-dim); font-size: 0.85rem; flex-shrink: 0; width: 14px; text-align: right; }

.exec-detail {
  padding: 0.75rem 0.85rem;
  border-top: 1px solid var(--border);
  background: var(--panel-alt);
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.detail-row { display: flex; gap: 0.6rem; align-items: flex-start; font-size: 0.8rem; }
.detail-label { min-width: 90px; color: var(--fg-dim); font-weight: 500; }
.detail-value { color: var(--fg); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.78rem; word-break: break-all; }
.detail-value--pre { white-space: pre-wrap; margin: 0; background: var(--panel); border: 1px solid var(--border); padding: 0.4rem 0.55rem; border-radius: 4px; flex: 1; }

.related-block {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.5rem;
  padding: 0.55rem 0.65rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.related-header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.related-actions { display: flex; gap: 0.35rem; flex-wrap: wrap; }
.related-count { color: var(--fg-dim); font-weight: 400; margin-left: 0.25rem; font-size: 0.72rem; }
.related-empty { font-size: 0.78rem; color: var(--fg-dim); padding: 0.35rem 0; line-height: 1.5; }
.related-empty code {
  background: var(--panel-hi);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  font-size: 0.72rem;
}
.related-error { margin: 0; }
.related-list-wrap { position: relative; display: flex; flex-direction: column; }
.autoscroll-hint {
  align-self: center;
  position: sticky;
  top: 0.25rem;
  z-index: 2;
  margin: 0.25rem 0;
  padding: 0.3rem 0.7rem;
  background: var(--panel-alt);
  color: var(--panel-alt);
  border: none;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
  transition: background 120ms;
}
.autoscroll-hint:hover { background: var(--fg); }
.pause-btn--paused {
  background: var(--yellow-bg);
  border-color: var(--warn);
  color: var(--warn);
}
.related-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  border-top: 1px solid var(--panel-hi);
  padding-top: 0.35rem;
}
.related-card {
  border-radius: 4px;
  overflow: hidden;
}
/* Tool-call cards get a left rail in warn so they pop out of the feed
   without pouring a strong tint over the message. */
.related-card--tool {
  background: var(--panel-alt);
  box-shadow: inset 3px 0 0 0 var(--warn);
}
.related-card--open { background: var(--panel-hi); }
/* Two-row layout so events read cleanly even in the narrow drawer:
   line 1 = time + level chip + tool/event tag,
   line 2 = message (wrapped across full width). */
.related-row {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  grid-template-rows: auto auto;
  align-items: center;
  gap: 0.15rem 0.5rem;
  width: 100%;
  padding: 0.35rem 0.4rem;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  font-size: 0.76rem;
  color: var(--fg);
}
.related-row:hover { background: var(--panel-hi); }
.related-chevron {
  color: var(--fg-dim);
  font-size: 0.8rem;
  grid-column: 4;
  grid-row: 1 / span 2;
  align-self: center;
}
.related-detail {
  padding: 0.5rem 0.6rem 0.6rem;
  border-top: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.related-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.related-detail-json {
  margin: 0;
  padding: 0.5rem 0.6rem;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-all;
}
.related-time {
  grid-column: 1;
  grid-row: 1;
  font-variant-numeric: tabular-nums;
  color: var(--fg-dim);
  font-size: 0.72rem;
  font-family: 'SF Mono', 'Fira Code', monospace;
  white-space: nowrap;
}
.related-level {
  grid-column: 2;
  grid-row: 1;
  font-size: 0.65rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  font-weight: 600;
  text-transform: lowercase;
  min-width: 46px;
  text-align: center;
  justify-self: start;
}
.related-tool {
  grid-column: 3;
  grid-row: 1;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  overflow: hidden;
}
.related-tool-tag {
  font-size: 0.65rem;
  padding: 0.05rem 0.4rem;
  border-radius: 3px;
  background: var(--info);
  color: var(--panel);
  text-transform: lowercase;
  font-weight: 600;
  flex-shrink: 0;
}
.related-tool-tag--pending { background: var(--warn); }
.related-tool-tag--orphan { background: var(--fg-dim); }
.related-detail-section { display: flex; flex-direction: column; gap: 0.35rem; }
.related-detail-section + .related-detail-section { margin-top: 0.5rem; }
.related-detail-note {
  margin-top: 0.4rem;
  padding: 0.4rem 0.55rem;
  border: 1px dashed var(--border-hi);
  border-radius: 4px;
  background: var(--yellow-bg);
  color: var(--warn);
  font-size: 0.72rem;
  line-height: 1.4;
}
.related-detail-note code { font-family: 'SF Mono', 'Fira Code', monospace; }
.related-tool-name {
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--info);
  font-size: 0.72rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.related-event {
  grid-column: 3;
  grid-row: 1;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--fg-dim);
  font-size: 0.7rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.related-msg {
  grid-column: 1 / span 3;
  grid-row: 2;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-mute);
  padding-left: 0.1rem;
}

.detail-json-block { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.35rem; }
.detail-json-header { display: flex; justify-content: space-between; align-items: center; }
.detail-json {
  margin: 0;
  padding: 0.55rem 0.7rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-all;
}

.load-more { display: flex; justify-content: center; margin-top: 0.85rem; }
</style>
