import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GatewayAdmissionCard from '../GatewayAdmissionCard.vue'
import type { GatewayAdmission } from '../api'

function admission(over: Partial<GatewayAdmission> = {}): GatewayAdmission {
  return { maxConcurrentRuns: null, rules: [], ...over }
}

describe('GatewayAdmissionCard', () => {
  it('no pisa la regla que el usuario está editando cuando el poll re-lee lo mismo', async () => {
    const stored = admission({ rules: [{ field: 'assignee', op: 'equals', value: 'julianjab' }] })
    const wrapper = mount(GatewayAdmissionCard, { props: { modelValue: stored, saving: false } })

    const valueInput = wrapper.findAll('input').at(-1)
    await valueInput?.setValue('otro-user')
    // El console re-lee cada 5s: mismo contenido, objeto nuevo.
    await wrapper.setProps({ modelValue: admission({ rules: [...stored.rules] }) })

    expect((wrapper.findAll('input').at(-1)?.element as HTMLInputElement).value).toBe('otro-user')
  })

  it('adopta las reglas del gateway cuando cambiaron de verdad', async () => {
    const wrapper = mount(GatewayAdmissionCard, {
      props: { modelValue: admission(), saving: false },
    })

    await wrapper.setProps({
      modelValue: admission({
        rules: [{ field: 'assignee', op: 'equals', value: 'julianjab' }],
      }),
    })

    expect(wrapper.html()).toContain('julianjab')
  })
})
