import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AssistantComposer from '../AssistantComposer.vue'
import { installFakeSpeech } from '../voice/test/fakeSpeech'
import { useVoiceStore } from '../voice/voiceStore'

const tasks = [
  { ref: 'acme/api#7', title: 'Mergear el fix', group: 'need', kind: 'merge' },
  { ref: 'acme/web#12', title: 'Review sin aprobar', group: 'need', kind: 'review' },
] as never

function render() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(AssistantComposer, {
    global: { plugins: [pinia] },
    props: {
      placeholder: 'Preguntá…',
      streaming: false,
      scope: { kind: 'general' },
      tasks,
      projects: [{ id: 'core', board: { owner: 'acme', number: 1 } }],
    },
  })
}

describe('AssistantComposer', () => {
  it('# lista las tareas; elegir una cambia el contexto y saca el # de la caja', async () => {
    const w = render()
    const box = w.get('textarea')
    await box.setValue('¿qué pasa con #web')
    expect(w.findAll('[role="option"]').map((o) => o.text())).toEqual([
      expect.stringContaining('12 web'),
    ])
    await box.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('scope')).toEqual([[{ kind: 'task', ref: 'acme/web#12' }]])
    expect((box.element as HTMLTextAreaElement).value).toBe('¿qué pasa con ')
    expect(w.emitted('send')).toBeUndefined()
  })

  it('@ ofrece todo el runner y los proyectos', async () => {
    const w = render()
    await w.get('textarea').setValue('@')
    const labels = w.findAll('[role="option"]').map((o) => o.text())
    expect(labels[0]).toContain('General')
    expect(labels[1]).toContain('core')
    await w.get('[data-test="opt-core"]').trigger('click')
    expect(w.emitted('scope')).toEqual([[{ kind: 'project', project_id: 'core' }]])
  })

  it('una ref escrita entera vale aunque no esté en la bandeja', async () => {
    const w = render()
    await w.get('textarea').setValue('#otra/repo#99')
    expect(w.find('[data-test="opt-otra/repo#99"]').exists()).toBe(true)
  })

  it('tocar la chip de contexto abre la lista; sin # ni @, Enter envía', async () => {
    const w = render()
    await w.get('[data-test="scope"]').trigger('click')
    expect(w.findAll('[role="option"]').length).toBe(2)
    await w.get('textarea').setValue('hola')
    await w.get('textarea').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('send')).toEqual([['hola']])
  })

  describe('dictado', () => {
    /** Un `webkitSpeechRecognition` de mentira: el test dice qué se reconoció. */
    class FakeRecognition {
      static last: FakeRecognition | null = null
      lang = ''
      continuous = false
      interimResults = false
      onresult: ((e: unknown) => void) | null = null
      onerror: ((e: { error: string }) => void) | null = null
      onend: (() => void) | null = null
      constructor() {
        FakeRecognition.last = this
      }
      start() {}
      stop() {
        this.onend?.()
      }
      hear(transcript: string, isFinal: boolean) {
        const result = Object.assign([{ transcript }], { isFinal })
        this.onresult?.({ resultIndex: 0, results: [result] })
      }
    }
    const g = globalThis as Record<string, unknown>

    afterEach(() => {
      delete g.webkitSpeechRecognition
      delete g.iaFlowDesktop
    })

    it('sin la API del navegador no hay micrófono', () => {
      expect(render().find('[data-test="mic"]').exists()).toBe(false)
    })

    it('en la app de escritorio tampoco (Electron no trae el servicio)', () => {
      g.webkitSpeechRecognition = FakeRecognition
      g.iaFlowDesktop = {}
      expect(render().find('[data-test="mic"]').exists()).toBe(false)
    })

    it('lo dictado se suma a lo escrito y enviar corta el dictado', async () => {
      g.webkitSpeechRecognition = FakeRecognition
      const w = render()
      const box = w.get('textarea')
      await box.setValue('Che,')
      await w.get('[data-test="mic"]').trigger('click')
      expect(w.get('[data-test="mic"]').attributes('aria-pressed')).toBe('true')
      FakeRecognition.last?.hear('qué falló hoy', false)
      await w.vm.$nextTick()
      expect((box.element as HTMLTextAreaElement).value).toBe('Che, qué falló hoy')
      await box.trigger('keydown', { key: 'Enter' })
      expect(w.emitted('send')).toEqual([['Che, qué falló hoy']])
      expect(w.get('[data-test="mic"]').attributes('aria-pressed')).toBe('false')
    })

    it('terminar con «enviar» manda la pregunta sin la palabra', async () => {
      g.webkitSpeechRecognition = FakeRecognition
      const w = render()
      await w.get('[data-test="mic"]').trigger('click')
      expect(w.find('[data-test="mic-hint"]').exists()).toBe(true)
      FakeRecognition.last?.hear('qué falló hoy enviar', false)
      await w.vm.$nextTick()
      expect(w.emitted('send')).toEqual([['qué falló hoy']])
      expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('')
      // Lo que el reconocedor mande tarde no vuelve a la caja.
      FakeRecognition.last?.hear('qué falló hoy enviar.', true)
      await w.vm.$nextTick()
      expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('')
    })

    it('4 s callado manda lo dictado; sin nada dicho sólo apaga el micrófono', async () => {
      vi.useFakeTimers()
      try {
        g.webkitSpeechRecognition = FakeRecognition
        const w = render()
        const mic = () => w.get('[data-test="mic"]').attributes('aria-pressed')
        await w.get('[data-test="mic"]').trigger('click')
        await vi.advanceTimersByTimeAsync(4000)
        expect(mic()).toBe('false')
        expect(w.emitted('send')).toBeUndefined()

        await w.get('[data-test="mic"]').trigger('click')
        FakeRecognition.last?.hear('cómo va la épica', false)
        await vi.advanceTimersByTimeAsync(3000)
        expect(w.emitted('send')).toBeUndefined()
        await vi.advanceTimersByTimeAsync(1000)
        expect(w.emitted('send')).toEqual([['cómo va la épica']])
        expect(mic()).toBe('false')
      } finally {
        vi.useRealTimers()
      }
    })

    it('con una respuesta en curso, «enviar» deja la pregunta escrita', async () => {
      g.webkitSpeechRecognition = FakeRecognition
      const w = render()
      await w.setProps({ streaming: true })
      await w.get('[data-test="mic"]').trigger('click')
      FakeRecognition.last?.hear('y la otra enviar', false)
      await w.vm.$nextTick()
      expect(w.emitted('send')).toBeUndefined()
      expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('y la otra')
    })

    it('en charla, el micrófono se abre solo y calla la voz', async () => {
      g.webkitSpeechRecognition = FakeRecognition
      const speech = installFakeSpeech()
      try {
        const w = render()
        const voice = useVoiceStore()
        voice.toggleTalk()
        await w.vm.$nextTick()
        expect(w.get('[data-test="mic"]').attributes('aria-pressed')).toBe('true')
        expect(speech.cancel).toHaveBeenCalled()
      } finally {
        speech.uninstall()
      }
    })

    it('con la voz prendida, se elige con qué voz se lee', async () => {
      localStorage.setItem('ia-flow.assistant.read-aloud', '1')
      const speech = installFakeSpeech([
        { name: 'Jorge', lang: 'es-ES' },
        { name: 'Mónica (Premium)', lang: 'es-ES' },
      ])
      try {
        const w = render()
        const pick = w.get('[data-test="voice-pick"]')
        expect((pick.element as HTMLSelectElement).value).toBe('Mónica (Premium)')
        await pick.setValue('Jorge')
        expect(useVoiceStore().voice?.name).toBe('Jorge')
      } finally {
        speech.uninstall()
        localStorage.clear()
      }
    })

    it('con la voz prendida, la velocidad cambia con cada clic, se aplica y queda guardada', async () => {
      localStorage.setItem('ia-flow.assistant.read-aloud', '1')
      const speech = installFakeSpeech([{ name: 'Mónica', lang: 'es-ES' }])
      try {
        const w = render()
        const rate = w.get('[data-test="rate"]')
        expect(rate.text()).toBe('1×')
        await rate.trigger('click')
        expect(rate.text()).toBe('1.25×')
        useVoiceStore().say('Hola.', 'k')
        expect(speech.rateOf).toEqual([1.25])
        expect(localStorage.getItem('ia-flow.assistant.rate')).toBe('1.25')
        // Después de la última, vuelve a la normal.
        await rate.trigger('click')
        expect(rate.text()).toBe('1.5×')
        await rate.trigger('click')
        expect(rate.text()).toBe('1×')
      } finally {
        speech.uninstall()
        localStorage.clear()
      }
    })

    it('sin permiso del micrófono lo dice', async () => {
      g.webkitSpeechRecognition = FakeRecognition
      const w = render()
      await w.get('[data-test="mic"]').trigger('click')
      FakeRecognition.last?.onerror?.({ error: 'not-allowed' })
      FakeRecognition.last?.onend?.()
      await w.vm.$nextTick()
      expect(w.get('[data-test="mic-error"]').text()).toContain('Sin permiso')
    })
  })
})
