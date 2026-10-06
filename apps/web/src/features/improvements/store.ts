import type { ImprovementProposal } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { useGithubSessionStore } from '@/stores/githubSession'
import { useImprovementsSignalStore } from '@/stores/improvementsSignal'
import { dismissImprovement, getImprovements, openImprovement } from './api'

/** Lo que va pasando con UNA propuesta mientras alguien la decide. */
export interface DecisionState {
  status: 'running' | 'error' | 'done'
  message?: string
  /** El issue creado (`done`). */
  url?: string
}

export const useImprovementsStore = defineStore('improvements', () => {
  const session = useGithubSessionStore()
  const signal = useImprovementsSignalStore()

  /** Las pendientes, como las tiene el runner. */
  const pending = ref<ImprovementProposal[]>([])
  /** Las que esta pestaña abrió: dejan de ser pendientes pero se quedan con su link al issue. */
  const opened = ref<ImprovementProposal[]>([])
  const states = ref<Record<string, DecisionState>>({})
  const loading = ref(false)

  /** Pendientes + recién abiertas, para dibujar. */
  const items = computed(() => [...pending.value, ...opened.value])
  /** Lo que espera una decisión: un contador en cero no se dibuja. */
  const count = computed(() => pending.value.length)

  async function load(): Promise<void> {
    loading.value = true
    try {
      const list = await getImprovements('open')
      pending.value = list?.items ?? []
    } catch {
      // Una falla transitoria no es un error de la bandeja: queda lo que había.
    } finally {
      loading.value = false
    }
  }

  function setState(id: string, state: DecisionState | undefined): void {
    const next = { ...states.value }
    if (state) next[id] = state
    else delete next[id]
    states.value = next
  }

  async function decide(
    proposal: ImprovementProposal,
    call: typeof openImprovement,
    ok: (result: ImprovementProposal | undefined) => void,
  ): Promise<void> {
    const id = proposal.id
    if (states.value[id]?.status === 'running') return
    setState(id, { status: 'running' })
    try {
      const result = await session.withToken((token) => call(id, token))
      if (!result) {
        setState(id, undefined)
        session.requestLogin()
        return
      }
      if (!result.ok) {
        setState(id, { status: 'error', message: result.message })
        // Ya la decidió otra persona (409) o no existe: lo que muestro está viejo.
        void load()
        return
      }
      ok(result.proposal)
      setState(id, { status: 'done', message: result.message, url: result.proposal?.issue_url })
    } catch (err) {
      setState(id, { status: 'error', message: extractErrorMessage(err) })
    }
  }

  function open(proposal: ImprovementProposal): Promise<void> {
    return decide(proposal, openImprovement, (result) => {
      pending.value = pending.value.filter((p) => p.id !== proposal.id)
      opened.value = [...opened.value, result ?? { ...proposal, status: 'opened' }]
    })
  }

  function dismiss(proposal: ImprovementProposal): Promise<void> {
    return decide(proposal, dismissImprovement, () => {
      pending.value = pending.value.filter((p) => p.id !== proposal.id)
      setState(proposal.id, undefined)
    })
  }

  // El runner avisó (stream o polling de la bandeja): se recarga.
  watch(
    () => signal.tick,
    () => void load(),
  )

  return { pending, opened, items, count, states, loading, load, open, dismiss }
})
