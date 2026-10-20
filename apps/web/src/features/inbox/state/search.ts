import type { BoardRest, Inbox, InboxItem } from '@ia-flow/shared'
import { computed, type Ref, ref } from 'vue'
import {
  exactRef,
  githubSearchUrl,
  parseSearch,
  searchCards,
  splitRef,
} from '@/features/inbox/queue/search'

// El buscador de la bandeja: lo que se escribió y lo que coincide en la bandeja (tras el filtro de
// proyecto), «Por arrancar» y el resto del board. Vive dentro del store (`store.ts` la compone).

interface SearchDeps {
  scoped: Ref<InboxItem[]>
  inbox: Ref<Inbox | null>
  runner: Ref<Inbox | null>
  rest: Ref<BoardRest | null>
  /** Trae el resto del board si todavía no está: buscar también mira ahí. */
  loadRest: () => Promise<void>
  restLoading: Ref<boolean>
}

export function createSearch(deps: SearchDeps) {
  const query = ref('')
  const search = computed(() => parseSearch(query.value))

  const hits = computed(() => {
    const s = search.value
    if (!s) return []
    const feed = deps.inbox.value?.feed ?? deps.runner.value?.feed
    return searchCards(s, {
      items: deps.scoped.value,
      ready: feed?.ready ?? [],
      waiting: feed?.waiting ?? [],
      rest: deps.rest.value?.columns ?? [],
    })
  })

  const known = computed(() => [
    ...(deps.inbox.value?.items ?? []).map((i) => i.ref),
    ...(deps.rest.value?.columns ?? []).flatMap((c) => c.items.map((i) => i.ref)),
  ])

  /** La ref exacta que se escribió y no aparece entre lo que coincide: se ofrece abrirla igual. */
  const exact = computed(() => {
    const s = search.value
    const ref = s ? exactRef(s, known.value) : null
    return ref && !hits.value.some((h) => h.ref.toLowerCase() === ref.toLowerCase()) ? ref : null
  })

  /** La organización del runner (el owner de sus tareas), para buscar en GitHub. */
  const github = computed(() => {
    const s = search.value
    if (!s) return null
    const org = known.value.map(splitRef).find(Boolean)?.owner ?? null
    return githubSearchUrl(s, org)
  })

  function setQuery(value: string): void {
    query.value = value
    if (search.value && !deps.rest.value && !deps.restLoading.value) void deps.loadRest()
  }

  return {
    searchQuery: query,
    search,
    searchHits: hits,
    searchExact: exact,
    searchGithub: github,
    setSearchQuery: setQuery,
  }
}
