import { defineStore } from 'pinia'
import { ref } from 'vue'

// «Mostrame esta tarea en la bandeja», desde afuera de la bandeja: el asistente
// nombra tareas y la bandeja las abre, y feature → feature está prohibido. Como
// `stores/assistant.ts`, es sólo el pedido; abrirla y llevarla a la vista es de
// `features/inbox/`.

export const useTaskFocusStore = defineStore('task-focus', () => {
  /** La tarea pedida, hasta que la bandeja la consume. */
  const request = ref<string | null>(null)

  function focus(ref: string): void {
    request.value = ref
  }

  function consume(): string | null {
    const ref = request.value
    request.value = null
    return ref
  }

  return { request, focus, consume }
})
