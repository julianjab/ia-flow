import { describe, expect, it } from 'vitest'
import { tokenize } from '../tokenize.js'

describe('tokenize', () => {
  it('separa por whitespace', () => {
    expect(tokenize('git status')).toEqual(['git', 'status'])
  })

  it('respeta comillas dobles como un solo token', () => {
    expect(tokenize('git commit -m "nice work"')).toEqual(['git', 'commit', '-m', 'nice work'])
  })

  it('respeta comillas simples como un solo token', () => {
    expect(tokenize("echo 'hola mundo'")).toEqual(['echo', 'hola mundo'])
  })

  it('ignora espacios múltiples', () => {
    expect(tokenize('git   status')).toEqual(['git', 'status'])
  })

  it('rechaza metacaracteres de shell fuera de comillas', () => {
    expect(() => tokenize('ls | grep foo')).toThrow('|')
    expect(() => tokenize('git status; rm -rf /')).toThrow(';')
    expect(() => tokenize('echo $HOME')).toThrow('$')
    expect(() => tokenize('cat a > b')).toThrow('>')
  })

  it('tira con una comilla sin cerrar', () => {
    expect(() => tokenize('echo "sin cerrar')).toThrow('sin cerrar')
  })

  describe('escapes dentro de comillas dobles', () => {
    it('\\" es una comilla literal y no cierra el string', () => {
      expect(tokenize('git commit -m "a \\"b c\\" d"')).toEqual([
        'git',
        'commit',
        '-m',
        'a "b c" d',
      ])
    })

    it('reduce \\\\, \\$ y \\` al carácter escapado', () => {
      expect(tokenize('echo "x \\\\ y \\$z \\`w\\`"')).toEqual(['echo', 'x \\ y $z `w`'])
    })

    it('conserva la barra ante cualquier otro carácter', () => {
      expect(tokenize('echo "a\\nb"')).toEqual(['echo', 'a\\nb'])
    })

    it('un string que termina en \\" sigue sin cerrar', () => {
      expect(() => tokenize('echo "abc\\"')).toThrow('sin cerrar')
      expect(() => tokenize('echo "abc\\')).toThrow('sin cerrar')
    })
  })

  it('las comillas simples no interpretan escapes', () => {
    expect(tokenize("echo 'a\\\"b'")).toEqual(['echo', 'a\\"b'])
  })

  it('fuera de comillas la barra sigue siendo un carácter más', () => {
    expect(tokenize('echo a\\b')).toEqual(['echo', 'a\\b'])
  })
})
