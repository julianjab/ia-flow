import { describe, expect, it } from 'vitest'
import { parseInline } from '../format'
import { parseAssistantEvent, splitSse } from '../sse'

describe('splitSse', () => {
  it('corta eventos completos y devuelve el resto a medias', () => {
    const { events, rest } = splitSse('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')
    expect(events).toEqual(['{"a":1}', '{"b":2}'])
    expect(rest).toBe('data: {"c"')
  })

  it('un evento partido en dos chunks se completa al sumar el siguiente', () => {
    const first = splitSse('data: {"type":"te')
    expect(first.events).toEqual([])
    const second = splitSse(`${first.rest}xt","delta":"hola"}\n\n`)
    expect(second.events).toEqual(['{"type":"text","delta":"hola"}'])
    expect(second.rest).toBe('')
  })

  it('acepta \\r\\n, comentarios, otros campos y varias líneas data', () => {
    const { events } = splitSse(
      ': keep-alive\r\n\r\nevent: x\r\nid: 3\r\ndata: uno\r\ndata: dos\r\n\r\n',
    )
    expect(events).toEqual(['uno\ndos'])
  })

  it('data sin espacio después de los dos puntos también vale', () => {
    expect(splitSse('data:{"a":1}\n\n').events).toEqual(['{"a":1}'])
  })
})

describe('parseAssistantEvent', () => {
  it('valida los cinco tipos del contrato', () => {
    expect(parseAssistantEvent('{"type":"text","delta":"hola"}')).toEqual({
      type: 'text',
      delta: 'hola',
    })
    expect(
      parseAssistantEvent('{"type":"tool","name":"get_task","summary":"leyendo a/b#1"}'),
    ).toMatchObject({
      type: 'tool',
    })
    expect(parseAssistantEvent('{"type":"done","text":"fin"}')).toEqual({
      type: 'done',
      text: 'fin',
    })
    expect(parseAssistantEvent('{"type":"error","message":"boom"}')).toEqual({
      type: 'error',
      message: 'boom',
    })
    expect(
      parseAssistantEvent(
        '{"type":"proposal","proposal":{"id":"p1","ref":"a/b#1","action":"merge","label":"Mergear","reason":"CI verde"}}',
      ),
    ).toMatchObject({ type: 'proposal' })
  })

  it('descarta lo que no cumple el contrato', () => {
    expect(parseAssistantEvent('no json')).toBeNull()
    expect(parseAssistantEvent('{"type":"text"}')).toBeNull()
    expect(
      parseAssistantEvent(
        '{"type":"proposal","proposal":{"id":"p","ref":"r","action":"borrar_todo","label":"l","reason":"r"}}',
      ),
    ).toBeNull()
  })
})

describe('parseInline', () => {
  it('separa `código` y **negrita** del texto, sin tocar el resto', () => {
    expect(parseInline('Corre `build` y **falló** ya')).toEqual([
      { kind: 'text', text: 'Corre ' },
      { kind: 'code', text: 'build' },
      { kind: 'text', text: ' y ' },
      { kind: 'bold', text: 'falló' },
      { kind: 'text', text: ' ya' },
    ])
  })

  it('nunca interpreta HTML: llega como texto', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { kind: 'text', text: '<img src=x onerror=alert(1)>' },
    ])
  })

  it('marcas sin cerrar quedan como texto', () => {
    expect(parseInline('a `b y **c')).toEqual([{ kind: 'text', text: 'a `b y **c' }])
  })
})
