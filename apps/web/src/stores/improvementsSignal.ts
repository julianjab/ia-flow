import { defineStore } from 'pinia'
import { ref } from 'vue'

// «Las mejoras propuestas cambiaron», desde afuera de su feature: el stream del runner lo escucha
// `features/inbox/` y quien las muestra es `features/improvements/`, y feature → feature está
// prohibido. Es sólo la señal (un contador que se mira con `watch`); recargar es de quien la lee.

export const useImprovementsSignalStore = defineStore('improvements-signal', () => {
  const tick = ref(0)

  function bump(): void {
    tick.value += 1
  }

  return { tick, bump }
})
