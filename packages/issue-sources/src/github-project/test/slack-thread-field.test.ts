import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_SLACK_THREAD_FIELD,
  parseSlackThreadField,
  readSlackThreadField,
} from '../slack-thread-field.js'

describe('parseSlackThreadField', () => {
  it('ausente ⇒ el default, así un board que ya tiene el campo no toca nada', () => {
    expect(parseSlackThreadField(undefined)).toBe(DEFAULT_SLACK_THREAD_FIELD)
  })

  it('null ⇒ el board no lo guarda (la fuente cae al PR)', () => {
    expect(parseSlackThreadField(null)).toBeNull()
  })

  it('acepta un nombre propio y lo recorta', () => {
    expect(parseSlackThreadField('  Hilo Slack ')).toBe('Hilo Slack')
  })

  it('rechaza vacío y no-string', () => {
    expect(() => parseSlackThreadField('')).toThrow(/slackThreadField inválido/)
    expect(() => parseSlackThreadField('   ')).toThrow(/slackThreadField inválido/)
    expect(() => parseSlackThreadField(42)).toThrow(/slackThreadField inválido/)
  })

  // Mismos motivos que el working marker: `Status` lo escribe cada transición.
  it("rechaza 'Status' en cualquier caja", () => {
    expect(() => parseSlackThreadField('status')).toThrow(/Status/)
  })

  it('rechaza un campo multi-valor: el link necesita un campo de texto', () => {
    expect(() => parseSlackThreadField('Labels')).toThrow(/multi-valor/)
  })
})

describe('readSlackThreadField', () => {
  it('lee case-insensitive — el nombre lo escribe un humano en la config', () => {
    expect(readSlackThreadField('SlackThread', { slackthread: 'https://x' })).toBe('https://x')
  })

  it('un valor en blanco es ausencia', () => {
    expect(readSlackThreadField('SlackThread', { SlackThread: '  ' })).toBeUndefined()
  })

  it('sin campo configurado no lee nada', () => {
    expect(readSlackThreadField(null, { SlackThread: 'https://x' })).toBeUndefined()
  })

  it('sin fields devuelve undefined', () => {
    expect(readSlackThreadField('SlackThread', undefined)).toBeUndefined()
  })
})
