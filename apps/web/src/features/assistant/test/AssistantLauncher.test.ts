import type { AssistantProposal, AssistantStreamEvent } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let script: () => AsyncGenerator<AssistantStreamEvent> = async function* () {}
const executeProposal = vi.fn()

vi.mock('../api', () => ({
  streamAssistant: () => script(),
  executeProposal: (...a: unknown[]) => executeProposal(...a),
  fetchProjects: async () => [],
}))

import { useAssistantStore } from '@/stores/assistant'
import { useGithubSessionStore } from '@/stores/githubSession'
import { useTaskFocusStore } from '@/stores/taskFocus'
import AssistantLauncher from '../AssistantLauncher.vue'
import { useAssistantChatStore } from '../store'

const proposal: AssistantProposal = {
  id: 'p1',
  ref: 'acme/api#7',
  action: 'merge',
  label: 'Mergear el PR',
  reason: 'CI verde',
}

async function open(scope?: Parameters<ReturnType<typeof useAssistantStore>['open']>[0]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(AssistantLauncher, {
    global: { plugins: [pinia] },
    attachTo: document.body,
  })
  useAssistantStore().open(scope)
  await flushPromises()
  return {
    wrapper,
    ui: useAssistantStore(),
    chat: useAssistantChatStore(),
    session: useGithubSessionStore(),
  }
}

const $ = <T extends Element>(sel: string) => document.body.querySelector<T>(sel)
const $$ = (sel: string) => [...document.body.querySelectorAll(sel)]

describe('AssistantLauncher', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    executeProposal.mockReset()
    script = async function* () {
      yield { type: 'text', delta: 'Hola, soy el asistente.' }
      yield { type: 'done', text: 'Hola, soy el asistente.' }
    }
  })

  it('la burbuja es el único punto de entrada: abre y cierra una ventana, sin backdrop', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(AssistantLauncher, {
      global: { plugins: [pinia] },
      attachTo: document.body,
    })
    expect($$('.fab')).toHaveLength(1)
    ;($('.fab') as HTMLElement).click()
    await flushPromises()
    expect($('[role="dialog"]')).not.toBeNull()
    expect($('.fab')?.getAttribute('aria-expanded')).toBe('true')
    // La página de atrás sigue usable: no hay backdrop ni se bloquea el scroll.
    expect($('.bs-backdrop')).toBeNull()
    expect(document.body.style.overflow).toBe('')
    ;($('.fab') as HTMLElement).click()
    await flushPromises()
    expect($('[role="dialog"]')).toBeNull()
    wrapper.unmount()
  })

  it('cerrar no corta la respuesta: termina igual y la burbuja la marca como no leída', async () => {
    let release: () => void = () => {}
    script = async function* () {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      yield { type: 'text', delta: 'Listo.' }
      yield { type: 'done', text: 'Listo.' }
    }
    const { wrapper, ui, chat } = await open()
    const sent = chat.send('¿qué pasó?')
    await flushPromises()
    ui.close()
    await flushPromises()
    release()
    await sent
    await flushPromises()
    expect(chat.turns.at(-1)).toMatchObject({ kind: 'assistant', text: 'Listo.' })
    expect($('[data-test="unread"]')).not.toBeNull()
    ui.open()
    await flushPromises()
    expect($('[data-test="unread"]')).toBeNull()
    wrapper.unmount()
  })

  it('tocar una tarea de la respuesta oculta el chat y la abre en la bandeja', async () => {
    script = async function* () {
      yield { type: 'text', delta: 'Mirá esta.' }
      yield {
        type: 'tasks',
        items: [
          {
            ref: 'acme/api#7',
            project_id: 'core',
            title: 'Algo',
            url: 'https://github.com/acme/api/issues/7',
            group: 'need',
            kind: 'merge',
            labels: [],
            why: 'PR aprobado',
            since: '2026-09-30T10:00:00Z',
            actions: ['merge'],
          },
        ],
      }
      yield { type: 'done', text: 'Mirá esta.' }
    }
    const { wrapper, ui, chat } = await open()
    await chat.send('¿qué me necesita?')
    await flushPromises()
    ;($('[data-test="open-acme/api#7"]') as HTMLElement).click()
    await flushPromises()
    expect(ui.isOpen).toBe(false)
    expect(useTaskFocusStore().request).toBe('acme/api#7')
    // La conversación queda: la burbuja la vuelve a mostrar.
    expect(chat.turns.map((t) => t.kind)).toEqual(['user', 'assistant', 'tasks'])
    wrapper.unmount()
  })

  it('la ref de una propuesta abre su tarea (no se repite como card aparte)', async () => {
    script = async function* () {
      yield { type: 'proposal', proposal }
      yield { type: 'done', text: 'Conviene mergear.' }
    }
    const { wrapper, ui, chat } = await open()
    await chat.send('¿qué hago?')
    await flushPromises()
    ;($('[data-test="open-acme/api#7"]') as HTMLElement).click()
    await flushPromises()
    expect(ui.isOpen).toBe(false)
    expect(useTaskFocusStore().request).toBe('acme/api#7')
    wrapper.unmount()
  })

  it('Escape cierra la ventana', async () => {
    const { wrapper, ui } = await open()
    $('[role="dialog"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await flushPromises()
    expect(ui.isOpen).toBe(false)
    wrapper.unmount()
  })

  it('abierto desde una tarjeta fija el contexto de esa tarea y ofrece sus sugerencias', async () => {
    const { wrapper, chat } = await open({ kind: 'task', ref: 'acme/api#7' })
    expect(chat.scope).toEqual({ kind: 'task', ref: 'acme/api#7' })
    const chips = $$('.ap__scopes .ap__chip')
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['General', 'acme/api#7'])
    expect(chips[1]?.getAttribute('aria-pressed')).toBe('true')
    expect($$('.ap__suggest .ap__chip').map((c) => c.textContent?.trim())).toContain(
      '¿Qué pasó con esta tarea?',
    )
    wrapper.unmount()
  })

  it('un chip de sugerencia hace la pregunta y muestra la respuesta en streaming', async () => {
    const { wrapper } = await open()
    ;($('.ap__suggest .ap__chip') as HTMLElement).click()
    await flushPromises()
    expect(document.body.textContent).toContain('Hola, soy el asistente.')
    wrapper.unmount()
  })

  it('el composer envía con Enter y el textarea se limpia', async () => {
    const { wrapper, chat } = await open()
    const input = $<HTMLTextAreaElement>('#assistant-input') as HTMLTextAreaElement
    input.value = '¿está sano el runner?'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flushPromises()
    expect(chat.turns[0]).toMatchObject({ kind: 'user', text: '¿está sano el runner?' })
    expect(input.value).toBe('')
    wrapper.unmount()
  })

  it('mientras responde, Enviar pasa a Detener', async () => {
    script = async function* () {
      await new Promise(() => {})
    }
    const { wrapper, chat } = await open()
    void chat.send('hola')
    await flushPromises()
    const stop = $('[data-test="stop"]') as HTMLElement
    expect(stop.textContent?.trim()).toBe('Detener')
    wrapper.unmount()
  })

  it('una propuesta muestra Ejecutar / Descartar; Ejecutar usa el login del usuario y marca ✓', async () => {
    script = async function* () {
      yield { type: 'proposal', proposal }
      yield { type: 'done', text: 'Conviene mergear.' }
    }
    executeProposal.mockResolvedValue({ ok: true, message: 'Mergeado' })
    const { wrapper, chat, session } = await open()
    session.github = { token: 'gho_1', login: 'ada' }
    await chat.send('¿qué hago?')
    await flushPromises()

    expect(document.body.textContent).toContain('Mergear el PR')
    expect($('[data-test="dismiss"]')).not.toBeNull()
    ;($('[data-test="run"]') as HTMLElement).click()
    await flushPromises()
    expect(executeProposal).toHaveBeenCalledWith(proposal, 'gho_1')
    expect(document.body.textContent).toContain('✓ Ejecutada')
    wrapper.unmount()
  })

  it('sin login de GitHub, Ejecutar se vuelve «Iniciar sesión» y no manda nada', async () => {
    script = async function* () {
      yield { type: 'proposal', proposal }
      yield { type: 'done', text: '' }
    }
    const { wrapper, chat, session } = await open()
    await chat.send('a')
    await flushPromises()

    expect($('[data-test="run"]')).toBeNull()
    ;($('[data-test="login"]') as HTMLElement).click()
    expect(session.loginOpen).toBe(true)
    expect(executeProposal).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('un error del stream se muestra como línea ✕', async () => {
    script = async function* () {
      yield { type: 'error', message: 'provider caído' }
    }
    const { wrapper, chat } = await open()
    await chat.send('hola')
    await flushPromises()
    expect($('.ap__note')?.textContent).toContain('✕ provider caído')
    wrapper.unmount()
  })

  it('reabrir a mano no vuelve a fijar el contexto pedido la vez anterior', async () => {
    const { wrapper, ui, chat } = await open({ kind: 'task', ref: 'acme/api#7' })
    chat.setScope({ kind: 'general' })
    ui.close()
    await flushPromises()
    ui.open()
    await flushPromises()
    expect(chat.scope).toEqual({ kind: 'general' })
    wrapper.unmount()
  })
})
