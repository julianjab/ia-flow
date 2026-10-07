import type { InboxItem } from '@ia-flow/shared'
import { createLogger } from '@ia-flow/telemetry'
import { type ComputedRef, computed, type Ref, ref } from 'vue'
import { type ActionFailure, actionFailure } from '@/features/inbox/queue/advice'
import { type ConfirmCopy, confirmCopy, type QueueAction } from '@/features/inbox/queue/kinds'
import { useInboxStore } from '@/features/inbox/store'
import { useGithubSessionStore } from '@/stores/githubSession'

// El ciclo de UNA acción de la cola sobre una tarea —o sobre las hijas de un grupo, en serie—:
// pedir el login si falta, confirmar en línea si firma con GitHub o no se deshace, ejecutar con
// tu token y dejar el error pegado a su botón. Lo comparten «Lo primero», las filas de
// «Después», las hijas de un grupo, «Detener…» y el feed.

const log = createLogger('inbox:action')

type Target = Pick<InboxItem, 'ref' | 'pr' | 'action_defs'>

export interface DecisionActionSource {
  action: () => QueueAction | undefined
  /** Una tarea, o las hijas de un grupo (en serie). */
  targets: () => readonly Target[]
}

/** `needs-comment`: la acción pide un texto que todavía no se escribió. */
export type AskOutcome = 'asked' | 'ran' | 'login' | 'needs-comment' | 'none'

/** Lo que se dibuja de la acción: la confirmación y cómo terminó sobre UNA tarea (su error
 *  legible o su «✓»; en un grupo cada hija muestra el suyo). */
function useActionOutcome(source: DecisionActionSource, refs: ComputedRef<string[]>) {
  const store = useInboxStore()
  const session = useGithubSessionStore()
  const stateOf = () => (refs.value.length === 1 ? store.actions[refs.value[0] ?? ''] : undefined)

  const failure = computed<ActionFailure | null>(() => {
    const action = source.action()
    const state = stateOf()
    if (!action || !state || state.pending) return null
    const message = state.error ?? (state.result && !state.result.ok ? state.result.message : null)
    return message ? actionFailure(action.label, message) : null
  })
  const done = computed(() => {
    const result = stateOf()?.result
    return result?.ok ? result : null
  })
  /** Lo que se firma, dónde y con quién. */
  const copy = computed<ConfirmCopy | null>(() => {
    const action = source.action()
    return action ? confirmCopy(action, source.targets(), session.github?.login) : null
  })
  return { copy, failure, done }
}

/** Ejecuta la acción con tu token: sobre una tarea (con su texto) o, en un grupo, en serie. */
async function runWith(
  source: DecisionActionSource,
  refs: readonly string[],
  comment: Ref<string>,
  seriesBusy: Ref<boolean>,
): Promise<boolean> {
  const store = useInboxStore()
  const session = useGithubSessionStore()
  const action = source.action()
  if (!action) return false
  // Renovado si está por vencer; si GitHub ya no lo renueva, se pide el login otra vez.
  const token = await session.token().catch((err: unknown) => {
    log.warn('no se pudo renovar el token de GitHub', { error: String(err) })
    return null
  })
  if (!token) {
    session.requestLogin()
    return false
  }
  if (refs.length > 1) {
    seriesBusy.value = true
    try {
      return await store.runActionSeries(refs, action.id, token)
    } finally {
      seriesBusy.value = false
    }
  }
  const text = action.comment ? comment.value.trim() || undefined : undefined
  const result = await store.runAction(refs[0] ?? '', action.id, token, text)
  if (result?.ok) comment.value = ''
  return result?.ok === true
}

export function useDecisionAction(source: DecisionActionSource) {
  const store = useInboxStore()
  const session = useGithubSessionStore()

  const confirming = ref(false)
  const comment = ref('')
  const seriesBusy = ref(false)

  const refs = computed(() => source.targets().map((t) => t.ref))
  const busy = computed(
    () => seriesBusy.value || refs.value.some((r) => store.actions[r]?.pending === true),
  )

  const { copy, failure, done } = useActionOutcome(source, refs)

  const run = () => runWith(source, refs.value, comment, seriesBusy)

  /** El botón: confirma, pide el texto o el login, o ejecuta. */
  async function ask(): Promise<AskOutcome> {
    const action = source.action()
    if (!action || busy.value) return 'none'
    for (const r of refs.value) store.clearAction(r)
    if (action.comment === 'required' && !comment.value.trim()) return 'needs-comment'
    if (!session.github) {
      session.requestLogin()
      return 'login'
    }
    if (action.confirms) {
      confirming.value = true
      return 'asked'
    }
    await run()
    return 'ran'
  }

  /** «<Verbo> ahora». Devuelve si salió todo bien. */
  async function confirm(): Promise<boolean> {
    confirming.value = false
    return run()
  }

  function cancel(): void {
    confirming.value = false
  }

  return { confirming, comment, busy, copy, failure, done, ask, confirm, cancel, retry: run }
}
