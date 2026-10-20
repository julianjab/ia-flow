import { describe, expect, it, vi } from 'vitest'
import {
  CLIP_TTL_MS,
  fetchClip,
  insertAt,
  isTextField,
  type MacClip,
  macPulseBase,
  shouldShow,
} from '../macClipboard'

const clip: MacClip = { id: 'a1', text: 'git status', at: 1_000, truncated: false }

describe('macPulseBase', () => {
  it('la URL configurada gana, sin la barra final', () => {
    expect(macPulseBase(' https://otra.example/ ', 'app.julianjab.link')).toBe(
      'https://otra.example',
    )
  })
  it('bajo julianjab.link se asume la de mac-pulse', () => {
    expect(macPulseBase(undefined, 'app.julianjab.link')).toBe('https://mac-pulse.julianjab.link')
  })
  it('en localhost no hay pastilla: ya se está en la Mac', () => {
    expect(macPulseBase('', 'localhost')).toBeNull()
  })
})

describe('fetchClip', () => {
  const reply = (init: Partial<Response> & { json?: () => Promise<unknown> }) =>
    vi.fn(async () => init as Response)

  it('pide con la cookie y sin headers propios, y pasa el id que ya tiene', async () => {
    const f = reply({ status: 200, ok: true, type: 'cors', json: async () => ({ clip }) })
    expect(await fetchClip('https://mp', 'x y', f)).toEqual({ kind: 'clip', clip })
    expect(f).toHaveBeenCalledWith('https://mp/api/clipboard?since=x%20y', {
      credentials: 'include',
      redirect: 'manual',
      cache: 'no-store',
    })
  })
  it('204: no cambió', async () => {
    expect(await fetchClip('https://mp', 'a1', reply({ status: 204 }))).toEqual({ kind: 'same' })
  })
  it('la redirección de Access o un 401: sin sesión', async () => {
    expect(
      await fetchClip('https://mp', null, reply({ status: 0, type: 'opaqueredirect' })),
    ).toEqual({ kind: 'no-session' })
    expect(await fetchClip('https://mp', null, reply({ status: 401, type: 'cors' }))).toEqual({
      kind: 'no-session',
    })
  })
  it('CORS o sin red: error, sin romper', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await fetchClip('https://mp', null, f)).toEqual({ kind: 'error' })
  })
})

describe('shouldShow', () => {
  it('nuevo y reciente: sí', () => expect(shouldShow(clip, null, 2_000)).toBe(true))
  it('ya usado o descartado: no', () => expect(shouldShow(clip, 'a1', 2_000)).toBe(false))
  it('más viejo que el TTL: no', () =>
    expect(shouldShow(clip, null, clip.at + CLIP_TTL_MS)).toBe(false))
  it('sin nada copiado: no', () => expect(shouldShow(null, null, 2_000)).toBe(false))
})

describe('insertAt', () => {
  it('pega en el cursor, reemplazando la selección, y avisa con input', () => {
    const ta = document.createElement('textarea')
    document.body.append(ta)
    ta.value = 'hola mundo'
    ta.setSelectionRange(5, 10)
    const input = vi.fn()
    ta.addEventListener('input', input)
    insertAt(ta, 'Mac')
    expect(ta.value).toBe('hola Mac')
    expect(ta.selectionStart).toBe(8)
    expect(input).toHaveBeenCalledOnce()
    ta.remove()
  })
})

describe('isTextField', () => {
  it('textarea e input de texto sí; deshabilitados, checkbox o un botón no', () => {
    const text = document.createElement('input')
    const box = Object.assign(document.createElement('input'), { type: 'checkbox' })
    const off = Object.assign(document.createElement('textarea'), { disabled: true })
    expect(isTextField(document.createElement('textarea'))).toBe(true)
    expect(isTextField(text)).toBe(true)
    expect(isTextField(box)).toBe(false)
    expect(isTextField(off)).toBe(false)
    expect(isTextField(document.createElement('button'))).toBe(false)
  })
})
