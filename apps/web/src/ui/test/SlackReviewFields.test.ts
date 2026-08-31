import SlackReviewFields from '@/ui/SlackReviewFields.vue'
import { DEFAULT_SLACK_REVIEW_MESSAGES } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'

// Un `ref` de verdad y no un objeto con `.value`: el template auto-desenvuelve
// refs, así que un doble plano deja `integrations.slack` en undefined.
const slackEnabled = ref(true)
vi.mock('@/composables/useIntegrations', () => ({
  useIntegrations: () => ({
    integrations: computed(() => ({ slack: { enabled: slackEnabled.value, webhook: true } })),
  }),
}))

vi.mock('@/composables/useSlackDirectory', () => ({
  lookupChannel: async () => undefined,
  useSlackChannels: () => ({
    channels: { value: [] },
    loading: { value: false },
    failed: { value: false },
    warnings: { value: [] },
    search: vi.fn(),
    fetchNow: vi.fn(),
  }),
  useSlackMembers: () => ({
    members: { value: [] },
    loading: { value: false },
    failed: { value: false },
    search: vi.fn(),
    fetchNow: vi.fn(),
  }),
}))

function mountOpen(props: Record<string, unknown> = {}) {
  const wrapper = mount(SlackReviewFields, {
    props: { channel: '', reviewers: [], message: {}, ...props },
  })
  // Los campos viven detrás del colapsable: cerrado no hay nada que testear.
  wrapper.get('.srf-head').trigger('click')
  return wrapper
}

describe('SlackReviewFields — plantillas', () => {
  it('ofrece los dos textos con el default vigente de placeholder', async () => {
    const wrapper = mountOpen()
    await wrapper.vm.$nextTick()

    const areas = wrapper.findAll('textarea')
    expect(areas).toHaveLength(2)
    expect(areas[0].attributes('placeholder')).toBe(DEFAULT_SLACK_REVIEW_MESSAGES.first)
    expect(areas[1].attributes('placeholder')).toBe(DEFAULT_SLACK_REVIEW_MESSAGES.reReview)
  })

  it('lista las variables interpolables', async () => {
    const wrapper = mountOpen()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('{{mentions}}, {{prUrl}}, {{prTitle}}')
  })

  // El default es un placeholder, NO un valor: precargarlo convertiría a todo
  // repo que abra el desplegable en un repo con override.
  it('los textareas arrancan vacíos cuando no hay override', async () => {
    const wrapper = mountOpen()
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('textarea').map((a) => a.element.value)).toEqual(['', ''])
  })

  it('editar un texto emite el objeto entero, sin pisar el otro', async () => {
    const wrapper = mountOpen({ message: { reReview: 'ya escrito' } })
    await wrapper.vm.$nextTick()

    await wrapper.findAll('textarea')[0].setValue('nuevo primer pedido')
    expect(wrapper.emitted('update:message')?.at(-1)).toEqual([
      { reReview: 'ya escrito', first: 'nuevo primer pedido' },
    ])
  })

  it('el resumen cerrado avisa cuántos textos propios hay', () => {
    const wrapper = mount(SlackReviewFields, {
      props: { channel: 'C1', reviewers: [], message: { first: 'propio' } },
    })
    expect(wrapper.get('.srf-summary').text()).toContain('1 texto(s) propio(s)')
  })
})

describe('SlackReviewFields — sin Slack', () => {
  it('no dibuja nada: los pickers volverían vacíos y el pedido daría 503', () => {
    slackEnabled.value = false
    try {
      const wrapper = mount(SlackReviewFields, {
        props: { channel: '', reviewers: [], message: {} },
      })
      expect(wrapper.find('.srf').exists()).toBe(false)
    } finally {
      slackEnabled.value = true
    }
  })
})
