import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import AgentRunSection from '../AgentRunSection.vue'

// Los dos hijos hablan con el server al montarse (catálogo de tools) o traen
// su propio drag; acá interesa la franja, no ellos. El form del provider NO se
// stubea: que el registry resuelva uno es parte de lo que esta franja hace.
const stubs = {
  ProviderChoicesEditor: { template: '<div class="stub-provider" />' },
  ToolsEditor: { template: '<div class="stub-tools" />' },
}

beforeEach(() => {
  setActivePinia(createPinia())
})

function mountRun(props: Partial<InstanceType<typeof AgentRunSection>['$props']> = {}) {
  return mount(AgentRunSection, {
    props: {
      providerChoices: [{ providerId: 'anthropic-api' }],
      providers: [{ id: 'anthropic-api', name: 'Anthropic API' }],
      providerConfig: {},
      tools: undefined,
      mcpCatalog: [],
      selectedMcpCatalogIds: [],
      ...props,
    },
    global: { stubs },
  })
}

describe('AgentRunSection', () => {
  // R19: "cómo corre" es UNA franja. Que provider, config, tools y MCP estén
  // juntos es lo que hace que su resumen sea una sola línea de valores (R22).
  it('junta provider, su config, las tools y el catálogo MCP', () => {
    const wrapper = mountRun()
    // Sólo los labels PROPIOS de la franja: el form del provider aporta los
    // suyos (Model, Effort…) y ésos son de él, no de este orden.
    const labels = wrapper.findAll('.ars > .ff-row > .uc-label').map((l) => l.text())

    expect(labels).toEqual(['Provider *', 'Config del provider', 'Tools', 'MCP servers'])
    expect(wrapper.find('.stub-provider').exists()).toBe(true)
    expect(wrapper.find('.stub-tools').exists()).toBe(true)
  })

  it('tilda y destilda una entrada del catálogo MCP', async () => {
    const wrapper = mountRun({
      mcpCatalog: [
        { id: 'github', name: 'GitHub', description: null },
        { id: 'figma', name: 'Figma', description: null },
      ] as never,
      selectedMcpCatalogIds: ['github'],
    })

    const chips = wrapper.findAll('.ff-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].classes()).toContain('ff-chip--on')
    expect(chips[1].classes()).not.toContain('ff-chip--on')

    await chips[1].trigger('click')
    expect(wrapper.emitted('update:selectedMcpCatalogIds')?.at(-1)).toEqual([['github', 'figma']])

    await chips[0].trigger('click')
    expect(wrapper.emitted('update:selectedMcpCatalogIds')?.at(-1)).toEqual([[]])
  })

  // Sin catálogo el hint dice DÓNDE se crea uno, no "no hay nada": un vacío
  // que no dice cómo llenarse es un callejón.
  it('sin catálogo MCP dice dónde crear una entrada', () => {
    const wrapper = mountRun()

    expect(wrapper.findAll('.ff-chip')).toHaveLength(0)
    expect(wrapper.text()).toContain('General → MCP Catalog')
  })
})
