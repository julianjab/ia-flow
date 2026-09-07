import { onUnmounted, ref } from 'vue'

/**
 * Un reloj reactivo compartido.
 *
 * Existe porque la duración de un run EN VUELO se calcula contra el ahora, y
 * `Date.now()` adentro de un `computed` no es reactivo: la fila mostraba
 * `corriendo · 3s` para siempre, que es exactamente el "parece colgado" que la
 * duración en vivo intenta evitar.
 *
 * Un solo intervalo para toda la app: cada consumidor se suma al mismo tick, y
 * el intervalo se apaga cuando el último se va — N filas corriendo no son N
 * timers.
 */
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
let subscribers = 0

export function useNow(): { now: typeof now } {
  subscribers++
  if (timer === null) {
    timer = setInterval(() => {
      now.value = Date.now()
    }, 1000)
  }
  onUnmounted(() => {
    subscribers--
    if (subscribers <= 0 && timer !== null) {
      clearInterval(timer)
      timer = null
      subscribers = 0
    }
  })
  return { now }
}
