import { onUnmounted, ref } from 'vue'

/**
 * ¿Estamos bajo el breakpoint mobile?
 *
 * Es el MISMO 768px que usa el CSS, y se escucha en vez de leerse una vez al
 * montar: cruzar el breakpoint tiene que montar/desmontar chrome (el sidebar
 * arriba, la tab bar abajo), no sólo esconderlo con `display: none` — un pie
 * que nadie va a ver no se monta.
 *
 * Un solo listener para toda la app: el `matchMedia` se comparte entre
 * consumidores y se libera cuando se va el último.
 */
const QUERY = '(max-width: 768px)'
const mq =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : null

const isMobile = ref(mq?.matches ?? false)
let subscribers = 0

function onChange(e: MediaQueryListEvent) {
  isMobile.value = e.matches
}

export function useIsMobile(): { isMobile: typeof isMobile } {
  if (mq) {
    subscribers++
    if (subscribers === 1) mq.addEventListener('change', onChange)
    onUnmounted(() => {
      subscribers--
      if (subscribers <= 0) {
        mq.removeEventListener('change', onChange)
        subscribers = 0
      }
    })
  }
  return { isMobile }
}
