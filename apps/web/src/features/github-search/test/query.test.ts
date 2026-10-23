import { describe, expect, it } from 'vitest'
import {
  boardRepoNames,
  githubWebUrl,
  numberCandidates,
  parseQuery,
  planSearch,
  shownRepos,
} from '@/features/github-search/query'

describe('parseQuery', () => {
  it('reconoce el link, owner/repo#n, repo#n, un número y el texto', () => {
    expect(parseQuery('https://github.com/acme/api/pull/12#issuecomment-1')).toEqual({
      owner: 'acme',
      repo: 'api',
      number: 12,
    })
    expect(parseQuery('acme/api#4')).toEqual({ owner: 'acme', repo: 'api', number: 4 })
    expect(parseQuery('api 4')).toEqual({ repo: 'api', number: 4 })
    expect(parseQuery('#4')).toEqual({ number: 4 })
    expect(parseQuery('  etapa  ')).toEqual({ text: 'etapa' })
    expect(parseQuery('   ')).toBeNull()
  })
})

describe('planSearch', () => {
  const all = { org: 'acme', repo: null }
  const api = { org: 'acme', repo: 'api' }

  it('una ref va directo, con el owner de la org si no se dio', () => {
    expect(planSearch('web#3', all)).toEqual({ kind: 'ref', ref: 'acme/web#3' })
    expect(planSearch('other/web#3', api)).toEqual({ kind: 'ref', ref: 'other/web#3' })
  })

  it('un número va al repo elegido; sin repo, se busca en los repos candidatos', () => {
    expect(planSearch('12', api)).toEqual({ kind: 'ref', ref: 'acme/api#12' })
    expect(planSearch('12', all)).toEqual({ kind: 'number', number: 12 })
  })

  it('los candidatos de un número: los del board primero, después los más activos, sin repetir', () => {
    expect(numberCandidates(['api', 'web'], ['cli', 'API', 'docs'], 4)).toEqual([
      'api',
      'web',
      'cli',
      'docs',
    ])
    expect(numberCandidates(['api'], ['a', 'b', 'c'], 2)).toEqual(['api', 'a'])
  })

  it('el texto busca desde 3 letras', () => {
    expect(planSearch('et', all)).toEqual({ kind: 'note', note: 'Escribe al menos 3 letras.' })
    expect(planSearch('etapa', all)).toEqual({ kind: 'text', text: 'etapa' })
    expect(planSearch('', all)).toBeNull()
  })
})

describe('el selector de repos', () => {
  it('los del board primero; el resto por actividad sin repetirlos; filtra sin mayúsculas', () => {
    expect(shownRepos(['api'], ['web', 'API', 'cli'], '')).toEqual({
      board: ['api'],
      others: ['web', 'cli'],
    })
    expect(shownRepos(['api'], ['web', 'cli'], ' W ')).toEqual({ board: [], others: ['web'] })
  })

  it('del catálogo del board, sólo los repos de la org y sin repetir', () => {
    expect(boardRepoNames(['acme/api', 'ACME/api', 'other/x', 'acme/web', 'raro'], 'acme')).toEqual(
      ['api', 'web'],
    )
  })
})

it('githubWebUrl arma la misma búsqueda en github.com', () => {
  expect(githubWebUrl('etapa', { org: 'acme', repo: null })).toBe(
    'https://github.com/search?q=etapa%20org%3Aacme&type=issues',
  )
  expect(githubWebUrl('', { org: 'acme', repo: 'api' })).toBe(
    'https://github.com/search?q=repo%3Aacme%2Fapi&type=issues',
  )
})
