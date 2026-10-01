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
})
