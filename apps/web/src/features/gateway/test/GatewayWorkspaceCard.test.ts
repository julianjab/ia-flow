import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GatewayWorkspaceCard from '../GatewayWorkspaceCard.vue'
import type { GatewayWorkspace } from '../api'

function ws(over: Partial<GatewayWorkspace> = {}): GatewayWorkspace {
  return {
    reposBase: null,
    worktreeBase: null,
    gitAuthorName: null,
    gitAuthorEmail: null,
    ...over,
  }
}

function reposInput(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('input')[0]
}

describe('GatewayWorkspaceCard', () => {
  it('no borra lo que el usuario está tipeando cuando el poll re-lee lo mismo', async () => {
    const wrapper = mount(GatewayWorkspaceCard, {
      props: { modelValue: ws(), saving: false },
    })

    await reposInput(wrapper).setValue('/Users/vos/repos')
    // El console re-lee cada 5s: mismo contenido, objeto nuevo.
    await wrapper.setProps({ modelValue: ws() })

    expect((reposInput(wrapper).element as HTMLInputElement).value).toBe('/Users/vos/repos')
  })

  it('adopta el valor del gateway cuando cambió de verdad', async () => {
    const wrapper = mount(GatewayWorkspaceCard, {
      props: { modelValue: ws(), saving: false },
    })

    await reposInput(wrapper).setValue('/tmp/local')
    await wrapper.setProps({ modelValue: ws({ reposBase: '/srv/repos' }) })

    expect((reposInput(wrapper).element as HTMLInputElement).value).toBe('/srv/repos')
  })

  it('emite null por los campos vacíos, no cadenas vacías', async () => {
    const wrapper = mount(GatewayWorkspaceCard, {
      props: { modelValue: ws({ reposBase: '/srv/repos' }), saving: false },
    })

    await reposInput(wrapper).setValue('   ')
    await wrapper.find('button').trigger('click')

    expect(wrapper.emitted('save')?.[0][0]).toEqual(ws())
  })
})
