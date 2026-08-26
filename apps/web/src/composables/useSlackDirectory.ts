import type { SlackMemberRef } from '@ia-flow/shared'
import axios from 'axios'
import { type Ref, ref } from 'vue'

// Directorio de Slack para los pickers de reviewers y canal.
//
// Vive en `composables/` y no en una feature porque lo consume `ui/`
// (SlackMemberMultiSelect / SlackChannelField) y las features no se importan
// entre sí — un `features/slack/api.ts` obligaría a `features/repos` a
// cruzarse a otra feature.
//
// El server ya filtra y cachea (SlackDirectory); acá sólo se debouncea para no
// disparar un request por tecla.

export interface SlackChannelRef {
  id: string
  name: string
  isPrivate?: boolean
}

const DEBOUNCE_MS = 200

function useDirectory<T>(path: string, key: 'members' | 'channels') {
  // `as Ref<T[]>` y no `ref<T[]>` a secas: sobre un genérico, `ref` infiere
  // `Ref<UnwrapRef<T>[]>` y el template deja de ver los campos del elemento.
  const results = ref<T[]>([]) as Ref<T[]>
  const loading = ref(false)
  const failed = ref(false)
  // Motivos por los que la lista puede venir incompleta (un scope faltante, un
  // tipo de canal que el bot no puede ver). No es un error: hay resultados.
  const warnings = ref<string[]>([])
  let timer: ReturnType<typeof setTimeout> | undefined

  async function fetchNow(q: string) {
    loading.value = true
    try {
      const { data } = await axios.get<{ warnings?: string[] } & Record<string, T[]>>(path, {
        params: { q },
      })
      results.value = (data[key] as T[]) ?? []
      warnings.value = (data.warnings as string[] | undefined) ?? []
      failed.value = false
    } catch {
      // El picker vacío ya comunica el problema (falta el token o el scope);
      // romper el editor de repos por eso sería peor.
      results.value = []
      warnings.value = []
      failed.value = true
    } finally {
      loading.value = false
    }
  }

  function search(q: string) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void fetchNow(q), DEBOUNCE_MS)
  }

  return { results, loading, failed, warnings, search, fetchNow }
}

export function useSlackMembers() {
  const { results, loading, failed, warnings, search, fetchNow } = useDirectory<SlackMemberRef>(
    '/api/slack/users',
    'members',
  )
  return { members: results, loading, failed, warnings, search, fetchNow }
}

export function useSlackChannels() {
  const { results, loading, failed, warnings, search, fetchNow } = useDirectory<SlackChannelRef>(
    '/api/slack/channels',
    'channels',
  )
  return { channels: results, loading, failed, warnings, search, fetchNow }
}
