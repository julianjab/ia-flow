import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import AnthropicApiSettingsForm from '../AnthropicApiSettingsForm.vue'
import type { AnthropicApiSettings } from '../store'

const stubs = {
  ModelSelect: { template: '<div class="stub-model" />' },
  McpServersEditor: { template: '<div class="stub-mcp" />' },
}

const BASE: AnthropicApiSettings = {
  model: 'claude-sonnet-5',
  thinking: { type: 'enabled', budget_tokens: 0 },
  stream: false,
  systemPrompt: [],
  anthropicVersion: '',
  anthropicBeta: [],
}

function mountForm(overrides: Partial<AnthropicApiSettings> = {}) {
  return mount(AnthropicApiSettingsForm, {
    props: { modelValue: { ...BASE, ...overrides } },
    global: { stubs },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('AnthropicApiSettingsForm', () => {
  // R20: se pliega lo que se puede ignorar. Modelo, effort y stream son lo que
  // se toca; los cinco numéricos tienen default.
  it('deja tres controles visibles y tres bloques plegados', () => {
    const wrapper = mountForm()

    const sections = wrapper.findAll('.cs-header .cs-title').map((t) => t.text())
    expect(sections).toEqual(['Límites', 'Thinking', 'MCP servers'])
    for (const panel of wrapper.findAll('.cs-panel')) {
      expect((panel.element as HTMLElement).style.display).toBe('none')
    }
  })

  // R22: el encabezado plegado muestra el valor efectivo, no una descripción.
  it('resume cada bloque plegado con su valor', () => {
    const wrapper = mountForm({
      maxTokens: 64000,
      maxConcurrentRuns: 3,
      thinking: { type: 'adaptive', budget_tokens: 8000 },
      mcpServers: { github: { url: 'https://x' } } as never,
    })

    const summaries = wrapper.findAll('.cs-summary').map((s) => s.text())
    expect(summaries[0]).toBe('64k por respuesta · 3 en paralelo')
    expect(summaries[1]).toBe('adaptive · 8000')
    expect(summaries[2]).toBe('1 servidor')
  })

  it('sin tope de runs lo dice en vez de omitirlo', () => {
    const wrapper = mountForm()

    expect(wrapper.findAll('.cs-summary')[0].text()).toBe('32k por respuesta · sin tope de runs')
  })

  // El cartel bajo la sección no decía cuál de los ocho campos rompió la
  // combinación. El mensaje va donde está el control que la despeja.
  it('pone el error de effort en el campo de effort', () => {
    const wrapper = mountForm({ effort: 'max', model: 'claude-sonnet-5' })

    const effortRow = wrapper.get('#anthropic-effort').element.parentElement as HTMLElement
    expect(effortRow.querySelector('.ff-error')?.textContent).toContain('requiere un modelo Opus')
    expect(wrapper.get('#anthropic-effort').classes()).toContain('ff-field--error')
  })

  it('con un modelo Opus el mismo effort no marca error', () => {
    const wrapper = mountForm({ effort: 'max', model: 'claude-opus-5' })

    expect(wrapper.find('.ff-error').exists()).toBe(false)
  })

  it('pone el error del task budget en su propio campo, no en effort', () => {
    const wrapper = mountForm({ taskBudgetTokens: 50000, model: 'claude-sonnet-5' })

    expect(wrapper.get('#anthropic-task-budget').classes()).toContain('ff-field--error')
    expect(wrapper.get('#anthropic-effort').classes()).not.toContain('ff-field--error')
  })
})
