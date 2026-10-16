import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import type { Turn } from '@/features/assistant/store'
import { useReadAloud } from '../useReadAloud'
import { useVoiceStore } from '../voiceStore'
import { type FakeSpeech, installFakeSpeech } from './fakeSpeech'

const user = (id: number): Turn => ({ id, kind: 'user', text: '¿qué pasó?' })
const reply = (id: number, text: string, streaming: boolean, spoken?: string): Turn => ({
  id,
  kind: 'assistant',
  text,
  activity: null,
  streaming,
  ...(spoken ? { spoken } : {}),
})

let speech: FakeSpeech

beforeEach(() => {
  localStorage.clear()
  speech = installFakeSpeech([
    { name: 'Jorge', lang: 'es-ES' },
    { name: 'Mónica (Premium)', lang: 'es-ES' },
  ])
  setActivePinia(createPinia())
})
afterEach(() => speech.uninstall())

/** Una respuesta que llega y termina. */
async function arrive(turns: { value: Turn[] }, done: Turn) {
  turns.value = [user(1), { ...done, streaming: true, text: '' } as Turn]
  await nextTick()
  turns.value = [user(1), done]
  await nextTick()
}

describe('useReadAloud', () => {
  it('apagada no lee; prendida lee al terminar el resumen hablado, con la mejor voz', async () => {
    const turns = ref<Turn[]>([])
    useReadAloud(() => turns.value)
    const voice = useVoiceStore()
    await arrive(turns, reply(2, '**o/r#1** falló.', false, 'La tarea uno falló.'))
    expect(speech.said).toEqual([])

    voice.toggleRead()
    expect(localStorage.getItem('ia-flow.assistant.read-aloud')).toBe('1')
    expect(voice.wantsSpeech).toBe(true)
    await arrive(turns, reply(3, '**o/r#1** falló.', false, 'La tarea uno falló.'))
    expect(speech.said).toEqual([['La tarea uno falló.']])
    expect(speech.voiceOf).toEqual(['Mónica (Premium)'])
  })

  it('sin resumen (un runner viejo) lee la respuesta entera, en frases y sin markdown', async () => {
    localStorage.setItem('ia-flow.assistant.read-aloud', '1')
    const turns = ref<Turn[]>([])
    useReadAloud(() => turns.value)
    await arrive(turns, reply(2, 'Falló el **build**. Reintentalo.', false))
    expect(speech.said).toEqual([['Falló el build.', 'Reintentalo.']])
  })

  it('una conversación retomada no se lee; cambiar de conversación calla lo que se decía', async () => {
    localStorage.setItem('ia-flow.assistant.read-aloud', '1')
    const turns = ref<Turn[]>([user(1), reply(2, 'Vieja.', false)])
    useReadAloud(() => turns.value)
    await nextTick()
    turns.value = [user(1), reply(2, 'Vieja.', false), user(3)]
    await nextTick()
    expect(speech.said).toEqual([])

    await arrive(turns, reply(4, 'Nueva.', false))
    speech.cancel.mockClear()
    turns.value = []
    await nextTick()
    expect(speech.cancel).toHaveBeenCalled()
  })

  it('en charla, al terminar de leer pide escuchar otra vez', async () => {
    const turns = ref<Turn[]>([])
    useReadAloud(() => turns.value)
    const voice = useVoiceStore()
    voice.toggleTalk()
    // Prenderla ya pide escuchar.
    expect(voice.listenTick).toBe(1)
    await arrive(turns, reply(2, 'Listo.', false, 'Listo, ya está.'))
    expect(speech.said).toEqual([['Listo, ya está.']])
    expect(voice.listenTick).toBe(1)
    speech.finish()
    expect(voice.listenTick).toBe(2)
    expect(voice.speaking).toBeNull()
  })

  it('la voz elegida queda guardada', () => {
    const voice = useVoiceStore()
    voice.chooseVoice('Jorge')
    expect(voice.voice?.name).toBe('Jorge')
    setActivePinia(createPinia())
    expect(useVoiceStore().voice?.name).toBe('Jorge')
  })
})
