import { onUnmounted, type Ref, ref } from 'vue'

/**
 * Los breakpoints del design system, como refs reactivos.
 *
 * Se escuchan en vez de leerse una vez al montar: cruzar un breakpoint tiene
 * que montar/desmontar chrome —el sidebar arriba, la tab bar abajo, el panel de
 * detalle al costado—, no sólo esconderlo con `display: none`. Un pie que nadie
 * va a ver no se monta.
 *
 * Un solo listener por query para toda la app: el `matchMedia` se comparte
 * entre consumidores y se libera cuando se va el último.
 */

interface Shared {
  mq: MediaQueryList | null
  value: Ref<boolean>
  subscribers: number
  onChange: (e: MediaQueryListEvent) => void
}

const shared = new Map<string, Shared>()

function sharedFor(query: string): Shared {
  const existing = shared.get(query)
  if (existing) return existing
  const mq =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)
      : null
  const entry: Shared = {
    mq,
    value: ref(mq?.matches ?? false),
    subscribers: 0,
    onChange: (e) => {
      entry.value.value = e.matches
    },
  }
  shared.set(query, entry)
  return entry
}

function useMediaQuery(query: string): Ref<boolean> {
  const entry = sharedFor(query)
  if (entry.mq) {
    entry.subscribers++
    if (entry.subscribers === 1) {
      // Re-sincronizar al re-suscribir: sin listener el ref queda con el último
      // valor visto, y si la ventana cruzó el breakpoint mientras nadie
      // escuchaba, el próximo consumidor arrancaría con el ancho equivocado —
      // montando el sidebar en un teléfono, o la tab bar en un monitor.
      entry.value.value = entry.mq.matches
      entry.mq.addEventListener('change', entry.onChange)
    }
    onUnmounted(() => {
      entry.subscribers--
      if (entry.subscribers <= 0) {
        entry.mq?.removeEventListener('change', entry.onChange)
        entry.subscribers = 0
      }
    })
  }
  return entry.value
}

/** Bajo `--bp-shell` (768px): la capa táctil. Tab bar, sin sidebar, sheets en
 *  vez de popovers, modales a pantalla completa. */
export function useIsMobile(): { isMobile: Ref<boolean> } {
  return { isMobile: useMediaQuery('(max-width: 768px)') }
}

/** Sobre `--bp-split` (1100px): hay ancho para una segunda columna — el detalle
 *  al lado de la lista en vez de flotando encima. */
export function useIsSplit(): { isSplit: Ref<boolean> } {
  return { isSplit: useMediaQuery('(min-width: 1100px)') }
}
