import {
  type PhasePrompt,
  getPhasePrompts,
  resetPhasePrompt,
  updatePhasePrompt,
} from '@/features/prompts/api'
import type { StepType } from '@ia-flow/shared'
import axios from 'axios'
import { defineStore } from 'pinia'

export type { PhasePrompt, PhaseVariable } from '@/features/prompts/api'

interface State {
  phases: PhasePrompt[]
  loading: boolean
  saving: boolean
  error: string | null
}

function extractError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string; message?: string } | undefined
    return data?.error ?? data?.message ?? err.message
  }
  if (err instanceof Error) return err.message
  return 'Unknown error'
}

export const usePromptsStore = defineStore('prompts', {
  state: (): State => ({
    phases: [],
    loading: false,
    saving: false,
    error: null,
  }),
  actions: {
    async fetch() {
      this.loading = true
      this.error = null
      try {
        this.phases = await getPhasePrompts()
      } catch (err) {
        this.error = extractError(err)
        throw err
      } finally {
        this.loading = false
      }
    },
    async save(step: StepType, prompt: string) {
      this.saving = true
      this.error = null
      try {
        const updated = await updatePhasePrompt(step, prompt)
        this.phases = this.phases.map((p) => (p.step === step ? updated : p))
      } catch (err) {
        this.error = extractError(err)
        throw err
      } finally {
        this.saving = false
      }
    },
    async reset(step: StepType) {
      this.saving = true
      this.error = null
      try {
        const updated = await resetPhasePrompt(step)
        this.phases = this.phases.map((p) => (p.step === step ? updated : p))
      } catch (err) {
        this.error = extractError(err)
        throw err
      } finally {
        this.saving = false
      }
    },
  },
})
