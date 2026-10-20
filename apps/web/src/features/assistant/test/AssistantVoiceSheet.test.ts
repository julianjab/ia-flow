import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AssistantVoiceSheet from '../AssistantVoiceSheet.vue'
import { installFakeSpeech } from '../voice/test/fakeSpeech'
import { useVoiceStore } from '../voice/voiceStore'

function render() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(AssistantVoiceSheet, {
    global: { plugins: [pinia] },
    props: { open: true },
    attachTo: document.body,
  })
}

// El sheet se teletransporta al body: se busca ahí y no en el wrapper.
const $ = <T extends Element>(sel: string) => document.body.querySelector<T>(sel) as T

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
})

describe('AssistantVoiceSheet', () => {
  it('se elige con qué voz se lee', async () => {
    const speech = installFakeSpeech([
      { name: 'Jorge', lang: 'es-ES' },
      { name: 'Mónica (Premium)', lang: 'es-ES' },
    ])
    try {
      const w = render()
      const pick = $<HTMLSelectElement>('[data-test="voice-pick"]')
      expect(pick.value).toBe('Mónica (Premium)')
      pick.value = 'Jorge'
      pick.dispatchEvent(new Event('change'))
      expect(useVoiceStore().voice?.name).toBe('Jorge')
      w.unmount()
    } finally {
      speech.uninstall()
    }
  })

  it('leer en voz alta se prende y queda guardado', async () => {
    const speech = installFakeSpeech([{ name: 'Mónica', lang: 'es-ES' }])
    try {
      const w = render()
      $<HTMLInputElement>('[data-test="read"]').click()
      expect(useVoiceStore().read).toBe(true)
      expect(localStorage.getItem('ia-flow.assistant.read-aloud')).toBe('1')
      w.unmount()
    } finally {
      speech.uninstall()
    }
  })

  it('la velocidad elegida se aplica, se marca y queda guardada', async () => {
    const speech = installFakeSpeech([{ name: 'Mónica', lang: 'es-ES' }])
    try {
      const w = render()
      expect($('[data-test="rate-1"]').getAttribute('aria-pressed')).toBe('true')
      $<HTMLButtonElement>('[data-test="rate-1.25"]').click()
      await w.vm.$nextTick()
      expect($('[data-test="rate-1.25"]').getAttribute('aria-pressed')).toBe('true')
      useVoiceStore().say('Hola.', 'k')
      expect(speech.rateOf).toEqual([1.25])
      expect(localStorage.getItem('ia-flow.assistant.rate')).toBe('1.25')
      w.unmount()
    } finally {
      speech.uninstall()
    }
  })

  it('cambiar la velocidad mientras lee sigue desde la frase actual, a la velocidad nueva', async () => {
    const speech = installFakeSpeech([{ name: 'Mónica', lang: 'es-ES' }])
    try {
      const w = render()
      const voice = useVoiceStore()
      const after = vi.fn()
      voice.say('Uno. Dos. Tres.', 'k', after)
      speech.next()
      $<HTMLButtonElement>('[data-test="rate-1.25"]').click()
      expect(speech.said).toEqual([
        ['Uno.', 'Dos.', 'Tres.'],
        ['Dos.', 'Tres.'],
      ])
      expect(speech.rateOf).toEqual([1, 1.25])
      speech.finish()
      expect(after).toHaveBeenCalledTimes(1)
      expect(voice.speaking).toBeNull()
      w.unmount()
    } finally {
      speech.uninstall()
    }
  })
})
