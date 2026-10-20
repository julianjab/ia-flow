import { describe, expect, it } from 'vitest'
import {
  close,
  exactRef,
  githubSearchUrl,
  matches,
  parseSearch,
  searchCards,
} from '@/features/inbox/queue/search'

const card = (ref: string, title: string, over: Record<string, unknown> = {}) => ({
  ref,
  title,
  url: `https://github.com/${ref}`,
  ...over,
})

describe('parseSearch', () => {
  it('vacío no busca', () => {
    expect(parseSearch('   ')).toBeNull()
  })

  it('reconoce el link de un issue o PR, owner/repo#n, repo#n y un número', () => {
    expect(parseSearch('https://github.com/acme/web/pull/12#issuecomment-1')).toMatchObject({
      owner: 'acme',
      repo: 'web',
      number: 12,
    })
    expect(parseSearch('acme/web#12')).toMatchObject({ owner: 'acme', repo: 'web', number: 12 })
    expect(parseSearch('web 12')).toMatchObject({ repo: 'web', number: 12 })
    expect(parseSearch('#12')).toEqual({ number: 12, raw: '#12' })
  })

  it('lo demás es texto, en palabras sin tildes', () => {
    expect(parseSearch('Facturación_mensual')?.words).toEqual(['facturacion', 'mensual'])
  })
})

describe('matches', () => {
  it('el número coincide con el del issue o el de su PR', () => {
    const s = parseSearch('12')!
    expect(matches(s, 'acme/web#12', 't')).toBe(true)
    expect(matches(s, 'acme/web#7', 't', 12)).toBe(true)
    expect(matches(s, 'acme/web#7', 't')).toBe(false)
  })

  it('el repo y el owner, sin mayúsculas', () => {
    expect(matches(parseSearch('Web#12')!, 'acme/web#12', 't')).toBe(true)
    expect(matches(parseSearch('api#12')!, 'acme/web#12', 't')).toBe(false)
    expect(matches(parseSearch('other/web#12')!, 'acme/web#12', 't')).toBe(false)
  })

  it('el texto busca todas sus palabras en el título y el repo, no en el owner', () => {
    expect(matches(parseSearch('perfil web')!, 'acme/web#1', 'Etapa de perfilado')).toBe(true)
    expect(matches(parseSearch('acme')!, 'acme/web#1', 'Etapa')).toBe(false)
  })

  it('tolera un typo según el largo de la palabra', () => {
    expect(close('perfl', 'perfil')).toBe(true)
    expect(close('prefil', 'perfilado')).toBe(false)
    expect(close('facturacon', 'facturacion')).toBe(true)
    expect(close('ab', 'abc')).toBe(true)
    expect(close('abd', 'abc')).toBe(false)
  })
})

describe('searchCards', () => {
  const sources = {
    items: [
      card('acme/web#1', 'Cobro mensual', { group: 'need' }),
      card('acme/web#2', 'Login', {
        group: 'running',
        epic: { ref: 'acme/web#9', title: 'Pagos' },
      }),
    ],
    ready: [card('acme/api#3', 'Cobro anual')],
    waiting: [card('acme/api#4', 'Reintentos de cobro')],
    rest: [
      {
        status: 'Done',
        items: [card('acme/web#1', 'Cobro mensual'), card('acme/web#5', 'Cobro viejo')],
      },
    ],
  }

  it('junta la bandeja, Todo y el board, cada card una vez y con dónde está', () => {
    const hits = searchCards(parseSearch('cobro')!, sources)
    expect(hits.map((h) => [h.ref, h.where])).toEqual([
      ['acme/web#1', 'te necesita'],
      ['acme/api#3', 'puede arrancar'],
      ['acme/api#4', 'espera a otra'],
      ['acme/web#5', 'Done'],
    ])
    expect(hits[0]?.short).toBe('web#1')
  })

  it('buscar una épica trae sus tareas de la bandeja', () => {
    expect(searchCards(parseSearch('pagos')!, sources).map((h) => h.ref)).toEqual(['acme/web#2'])
  })
})

describe('exactRef y GitHub', () => {
  it('arma la ref con el owner dado o con el de otra card del mismo repo', () => {
    expect(exactRef(parseSearch('acme/web#40')!, [])).toBe('acme/web#40')
    expect(exactRef(parseSearch('web#40')!, ['acme/web#1'])).toBe('acme/web#40')
    expect(exactRef(parseSearch('api#40')!, ['acme/web#1'])).toBeNull()
    expect(exactRef(parseSearch('40')!, ['acme/web#1'])).toBeNull()
  })

  it('busca en la organización si se conoce', () => {
    expect(githubSearchUrl(parseSearch('cobro')!, 'acme')).toBe(
      'https://github.com/search?q=org%3Aacme%20cobro&type=issues',
    )
  })
})
