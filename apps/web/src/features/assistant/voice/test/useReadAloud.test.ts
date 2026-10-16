import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { Turn } from '@/features/assistant/store'
import { useReadAloud } from '../useReadAloud'

function speaker() {
  return { speak: vi.fn(), cancel: vi.fn() }
}

const user = (id: number): Turn => ({ id, kind: 'user', text: '¿qué pasó?' })
const reply = (id: number, text: string, streaming: boolean): Turn => ({
  id,
  kind: 'assistant',
  text,
  activity: null,
  streaming,
})

describe('useReadAloud', () => {
  beforeEach(() => localStorage.clear())

  it('apagado por defecto; prendido lee frase por frase mientras llega y el resto al terminar', async () => {
    const turns = ref<Turn[]>([])
    const s = speaker()
    const voice = useReadAloud(() => turns.value, s)
    expect(voice.enabled.value).toBe(false)
    voice.toggle()
    expect(localStorage.getItem('ia-flow.assistant.read-aloud')).toBe('1')

    turns.value = [user(1), reply(2, 'Falló el build', true)]
    await nextTick()
    expect(s.speak).not.toHaveBeenCalled()
    turns.value = [user(1), reply(2, 'Falló el build. Lo reintento', true)]
    await nextTick()
    expect(s.speak).toHaveBeenLastCalledWith('Falló el build.')
    turns.value = [user(1), reply(2, 'Falló el build. Lo reintento', false)]
    await nextTick()
    expect(s.speak).toHaveBeenLastCalledWith('Lo reintento')
    expect(s.speak).toHaveBeenCalledTimes(2)
  })

  it('una conversación retomada (sin stream) no se lee', async () => {
    localStorage.setItem('ia-flow.assistant.read-aloud', '1')
    const turns = ref<Turn[]>([])
    const s = speaker()
    useReadAloud(() => turns.value, s)
    turns.value = [user(1), reply(2, 'Respuesta vieja.', false)]
    await nextTick()
    expect(s.speak).not.toHaveBeenCalled()
  })

  it('cambiar de conversación o apagar la voz corta lo que se decía', async () => {
    localStorage.setItem('ia-flow.assistant.read-aloud', '1')
    const turns = ref<Turn[]>([user(1), reply(2, 'Uno. ', true)])
    const s = speaker()
    const voice = useReadAloud(() => turns.value, s)
    turns.value = [user(1), reply(2, 'Uno. Dos', true)]
    await nextTick()
    // Empezar una respuesta ya calla la anterior: se cuenta desde acá.
    s.cancel.mockClear()
    turns.value = []
    await nextTick()
    expect(s.cancel).toHaveBeenCalledTimes(1)
    voice.toggle()
    expect(s.cancel).toHaveBeenCalledTimes(2)
  })

  it('sin voz en el navegador no se ofrece', () => {
    expect(useReadAloud(() => [], null).supported).toBe(false)
  })
})
