import { onBeforeUnmount, onMounted } from 'vue'

/**
 * Corre `tick` al montar y cada `ms` mientras el componente está abierto; al desmontar, para. Un
 * tick que todavía no volvió no se pisa con otro (un runner lento no acumula pedidos). Devuelve
 * `now()`, para pedir uno fuera de turno («Revisar de nuevo»).
 */
export function usePoll(tick: () => Promise<void>, ms: number): { now: () => Promise<void> } {
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<void> | undefined

  function now(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = tick().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  onMounted(() => {
    void now()
    timer = setInterval(() => void now(), ms)
  })
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
    timer = undefined
  })
  return { now }
}
