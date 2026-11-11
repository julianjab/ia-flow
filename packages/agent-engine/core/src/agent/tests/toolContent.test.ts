import { describe, expect, it } from 'vitest'
import { parseToolContent, toolContent, toolContentText } from '../toolContent.js'

describe('toolContent', () => {
  const png = Buffer.from('fake png bytes').toString('base64')

  it('ida y vuelta: texto e imagen', () => {
    const result = toolContent([
      { type: 'text', text: 'la captura' },
      { type: 'image', mediaType: 'image/png', data: png },
    ])
    expect(parseToolContent(result)).toEqual([
      { type: 'text', text: 'la captura' },
      { type: 'image', mediaType: 'image/png', data: png },
    ])
  })

  it('un resultado de texto común no es contenido', () => {
    expect(parseToolContent('{"images":[]}')).toBeUndefined()
    expect(toolContentText('hola')).toBe('hola')
  })

  it('como texto: sin el base64, con el tamaño de la imagen', () => {
    const text = toolContentText(
      toolContent([
        { type: 'text', text: 'la captura' },
        { type: 'image', mediaType: 'image/jpeg', data: 'A'.repeat(4096) },
      ]),
    )
    expect(text).toBe('la captura\n[imagen image/jpeg, 3 KB]')
  })

  it('descarta un bloque con un tipo de imagen que la API no acepta', () => {
    const result = toolContent([
      { type: 'image', mediaType: 'image/svg+xml' as 'image/png', data: png },
      { type: 'text', text: 'ok' },
    ])
    expect(parseToolContent(result)).toEqual([{ type: 'text', text: 'ok' }])
  })
})
