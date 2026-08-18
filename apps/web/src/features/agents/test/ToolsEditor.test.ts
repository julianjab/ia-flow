import PromptEditor from '@/features/prompts/PromptEditor.vue'
import type { AgentToolEntry } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ToolsEditor from '../ToolsEditor.vue'

// ToolsEditor y el AiAssistPanel que monta pegan a /api/tools (fetch) y, vía
// projectConfigStore, a /api/project-config (axios) en onMounted. Sin
// backend no hay nada que devolver; que el catálogo quede vacío no afecta a
// los tests de acá (el toggle bash y los editores de allow/deny no dependen
// del catálogo) — mockeamos ambos sólo para que no queden promesas
// rechazadas sin manejar ensuciando la corrida.
vi.mock('@/features/project-config/api', () => ({
  fetchProjectConfig: vi.fn().mockResolvedValue({ config: null, raw: '' }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => [] }))
})

function mountEditor(tools: AgentToolEntry[] | undefined) {
  return mount(ToolsEditor, { props: { tools } })
}

function lastEmit(wrapper: ReturnType<typeof mountEditor>): AgentToolEntry[] | undefined {
  return wrapper.emitted('update:tools')?.at(-1)?.[0] as AgentToolEntry[] | undefined
}

describe('ToolsEditor — bash_run allow/deny draft', () => {
  it('does not reset the draft mid-edit when typing a second line (regression: watch echo clobbering the textarea)', async () => {
    const tools: AgentToolEntry[] = [{ name: 'bash_run', allow: ['git status'], deny: [] }]
    const wrapper = mountEditor(tools)
    await wrapper.vm.$nextTick()

    const allowEditor = wrapper.findAllComponents(PromptEditor)[0]
    // Simula apretar Enter para empezar una segunda línea — el textarea real
    // emitiría "git status\n" (línea nueva vacía) ANTES de que el usuario
    // termine de tipear el segundo patrón.
    await allowEditor.vm.$emit('update:modelValue', 'git status\n')

    expect(allowEditor.props('modelValue') as string).toBe('git status\n')

    await allowEditor.vm.$emit('update:modelValue', 'git status\ngit log')
    expect(allowEditor.props('modelValue') as string).toBe('git status\ngit log')

    const emitted = lastEmit(wrapper)
    const bashEntry = emitted?.find((t) => typeof t !== 'string')
    expect(bashEntry).toEqual({ name: 'bash_run', allow: ['git status', 'git log'], deny: [] })
  })

  it('still reflects an external prop change (different agent loaded)', async () => {
    const wrapper = mountEditor([{ name: 'bash_run', allow: ['git status'], deny: [] }])
    await wrapper.setProps({ tools: [{ name: 'bash_run', allow: ['npm run build'], deny: [] }] })
    await wrapper.vm.$nextTick()
    const allowEditor = wrapper.findAllComponents(PromptEditor)[0]
    expect(allowEditor.props('modelValue')).toBe('npm run build')
  })

  it('trims blank lines on commit without losing the in-progress draft', async () => {
    const wrapper = mountEditor([{ name: 'bash_run', allow: [], deny: [] }])
    const allowEditor = wrapper.findAllComponents(PromptEditor)[0]
    await allowEditor.vm.$emit('update:modelValue', '  git status  \n\n')
    const emitted = lastEmit(wrapper)
    const bashEntry = emitted?.find((t) => typeof t !== 'string') as { allow: string[] } | undefined
    expect(bashEntry?.allow).toEqual(['git status'])
  })
})
