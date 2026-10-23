import { type Ref, ref, watch } from 'vue'

// Si una sección quedó plegada, recordado en este navegador (como en el menú de Mac, donde cada
// sección se pliega con un clic en su título). Es una preferencia de quien mira: cada acceso al
// storage va en try/catch y, sin storage, dura lo que la pestaña.

const KEY = 'ia-flow:collapsed:'

function read(key: string): boolean {
  try {
    return localStorage.getItem(KEY + key) === '1'
  } catch {
    return false
  }
}

export function useCollapsed(key: string): Ref<boolean> {
  const collapsed = ref(read(key))
  watch(collapsed, (now) => {
    try {
      if (now) localStorage.setItem(KEY + key, '1')
      else localStorage.removeItem(KEY + key)
    } catch {
      /* sin storage: vale para esta pestaña */
    }
  })
  return collapsed
}
