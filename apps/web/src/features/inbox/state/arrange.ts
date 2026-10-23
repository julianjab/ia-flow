import type { InboxItem } from '@ia-flow/shared'
import { ref, watch } from 'vue'
import { serverTarget } from '@/composables/useServerTarget'
import { type Snooze, type SortMode, snoozeOf } from '@/features/inbox/queue/arrange'
import { serverKey } from '@/features/inbox/view/resolve'

// Lo que quien mira decide sobre «Para mí» en ESTE runner: el orden, las fijadas y las pospuestas.
// Es una preferencia de la persona, no del runner: vive en este navegador, por runner, como el
// dashboard editado (`view/storage.ts`). Cada acceso al storage va en try/catch.

const KEY = 'ia-flow:arrange:'

interface Saved {
  sort: SortMode
  pins: string[]
  snoozes: Snooze[]
}

const EMPTY: Saved = { sort: 'priority', pins: [], snoozes: [] }

function read(key: string): Saved {
  try {
    const raw = localStorage.getItem(KEY + key)
    if (!raw) return { ...EMPTY }
    const saved = JSON.parse(raw) as Partial<Saved>
    return {
      sort: saved.sort === 'recent' || saved.sort === 'oldest' ? saved.sort : 'priority',
      pins: Array.isArray(saved.pins) ? saved.pins.filter((p) => typeof p === 'string') : [],
      snoozes: Array.isArray(saved.snoozes)
        ? saved.snoozes.filter((s) => typeof s?.ref === 'string' && typeof s?.fp === 'string')
        : [],
    }
  } catch {
    return { ...EMPTY }
  }
}

function write(key: string, saved: Saved): void {
  try {
    localStorage.setItem(KEY + key, JSON.stringify(saved))
  } catch {
    /* sin storage, la preferencia dura lo que la pestaña */
  }
}

export function createArrange() {
  const key = () => serverKey(serverTarget().base)
  const initial = read(key())
  const sort = ref<SortMode>(initial.sort)
  const pins = ref<string[]>(initial.pins)
  const snoozes = ref<Snooze[]>(initial.snoozes)
  /** La última pospuesta, para «Deshacer». */
  const lastSnoozed = ref<Snooze | null>(null)

  watch(
    [sort, pins, snoozes],
    () => write(key(), { sort: sort.value, pins: pins.value, snoozes: snoozes.value }),
    {
      deep: true,
    },
  )

  /** Al cambiar de runner, lo suyo. */
  function reload(): void {
    const saved = read(key())
    sort.value = saved.sort
    pins.value = saved.pins
    snoozes.value = saved.snoozes
    lastSnoozed.value = null
  }

  const isPinned = (ref: string) => pins.value.includes(ref)

  function togglePin(ref: string): void {
    pins.value = isPinned(ref) ? pins.value.filter((p) => p !== ref) : [...pins.value, ref]
  }

  /** `until` en ms; `null` = hasta que cambie algo. Posponer desfija. */
  function snooze(item: InboxItem, until: number | null): void {
    const next = snoozeOf(item, until)
    snoozes.value = [...snoozes.value.filter((s) => s.ref !== item.ref), next]
    pins.value = pins.value.filter((p) => p !== item.ref)
    lastSnoozed.value = next
  }

  function wake(ref: string): void {
    snoozes.value = snoozes.value.filter((s) => s.ref !== ref)
    if (lastSnoozed.value?.ref === ref) lastSnoozed.value = null
  }

  function undoSnooze(): void {
    if (lastSnoozed.value) wake(lastSnoozed.value.ref)
  }

  /** Olvida lo que ya no aplica (fijadas que salieron, pospuestas que volvieron). */
  function prune(activePins: readonly string[], activeSnoozes: readonly Snooze[]): void {
    if (activePins.length !== pins.value.length) pins.value = [...activePins]
    if (activeSnoozes.length !== snoozes.value.length) snoozes.value = [...activeSnoozes]
  }

  return {
    sort,
    pins,
    snoozes,
    lastSnoozed,
    reload,
    isPinned,
    togglePin,
    snooze,
    wake,
    undoSnooze,
    prune,
  }
}
