import { describe, expect, it } from 'vitest'
import { forwardHeaders, parseProxyRunners, route, safePath } from '../routes.js'

const config = { runner: 'http://localhost:3001', runners: { prod: 'https://runner.interno' } }
const built = new Set(['index.html', 'sw.js', 'assets/app-123.js'])
const exists = (path: string) => built.has(path)

describe('route', () => {
  it('/api va al runner con su query', () => {
    expect(route('/api/inbox', '?x=1', config, exists)).toEqual({
      kind: 'proxy',
      target: 'http://localhost:3001/api/inbox?x=1',
    })
  })

  it('/<nombre>/… va al runner de IA_FLOW_PROXY_RUNNERS, sin el prefijo', () => {
    expect(route('/prod/api/inbox', '', config, exists)).toEqual({
      kind: 'proxy',
      target: 'https://runner.interno/api/inbox',
    })
  })

  it('un archivo del build: los de assets/ inmutables, el resto se revalida', () => {
    expect(route('/assets/app-123.js', '', config, exists)).toEqual({
      kind: 'file',
      path: 'assets/app-123.js',
      cache: 'immutable',
    })
    expect(route('/sw.js', '', config, exists)).toMatchObject({ kind: 'file', cache: 'revalidate' })
  })

  it('lo que no es archivo (una ruta de la SPA, la raíz) es index.html', () => {
    expect(route('/en-curso', '', config, exists)).toEqual({ kind: 'spa' })
    expect(route('/', '', config, exists)).toEqual({ kind: 'spa' })
    expect(route('/prod', '', config, exists)).toEqual({ kind: 'spa' })
  })
})

describe('safePath', () => {
  it('no deja salir del build', () => {
    expect(safePath('/../etc/passwd')).toBeNull()
    expect(safePath('/assets/%2e%2e/%2e%2e/secret')).toBeNull()
    expect(safePath('/a\\b')).toBeNull()
    expect(safePath('/%E0%A4%A')).toBeNull()
  })
})

describe('parseProxyRunners', () => {
  it('lee nombre=URL y descarta lo mal escrito', () => {
    expect(
      parseProxyRunners('prod=https://r.interno/, MAL=http://x, dev=ftp://y, sin-igual'),
    ).toEqual({
      prod: 'https://r.interno',
    })
    expect(parseProxyRunners(undefined)).toEqual({})
  })
})

describe('forwardHeaders', () => {
  it('saca Host y los de la conexión, deja el token', () => {
    const out = forwardHeaders(
      new Headers({
        host: 'app.julianjab.link',
        authorization: 'Bearer t',
        connection: 'keep-alive',
      }),
    )
    expect(out.get('host')).toBeNull()
    expect(out.get('connection')).toBeNull()
    expect(out.get('authorization')).toBe('Bearer t')
  })
})
