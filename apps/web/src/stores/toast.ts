import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ToastVariant = 'success' | 'error'

export interface Toast {
  id: number
  variant: ToastVariant
  message: string
}

const AUTO_DISMISS_MS = 4000

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([])
  let nextId = 1

  function push(variant: ToastVariant, message: string): number {
    const id = nextId++
    toasts.value.push({ id, variant, message })
    setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
    return id
  }

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  function success(message: string): number {
    return push('success', message)
  }

  function error(message: string): number {
    return push('error', message)
  }

  return { toasts, success, error, dismiss }
})
