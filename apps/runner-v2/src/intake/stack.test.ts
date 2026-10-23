import { describe, expect, it } from 'bun:test'
import type { GithubTaskReader } from '@ia-flow/github-tools'
import { refOfUrl, stackedOn, taskStack } from './stack.js'

const merged = { owner: 'o', repo: 'r', head: 'feat/a', headSha: 'abc', base: 'main' }
const dependent = { owner: 'o', repo: 'r', number: 7 }

function reader(baseRef: string | undefined, carries = false) {
  return {
    openPullRequest: async () =>
      baseRef === undefined ? undefined : { number: 70, headRef: 'feat/b', baseRef },
    contains: async () => carries,
  } as unknown as GithubTaskReader
}

describe('stackedOn', () => {
  it('el PR que apunta a la rama mergeada estaba apilado', async () => {
    expect(await stackedOn(reader('feat/a'), merged, dependent)).toBe(70)
  })

  it('el PR que GitHub ya reapuntó, pero trae la rama mergeada, también', async () => {
    expect(await stackedOn(reader('main', true), merged, dependent)).toBe(70)
    expect(await stackedOn(reader('main', false), merged, dependent)).toBeUndefined()
  })

  it('sin PR, o en otro repo, no estaba apilado', async () => {
    expect(await stackedOn(reader(undefined), merged, dependent)).toBeUndefined()
    expect(await stackedOn(reader('feat/a'), merged, { ...dependent, repo: 'web' })).toBeUndefined()
  })
})

describe('stackedOn — GitHub que no contesta', () => {
  it('un compare que falla (la rama ya no está) no estaba apilado, y no tira', async () => {
    const failing = {
      openPullRequest: async () => ({ number: 70, headRef: 'feat/b', baseRef: 'main' }),
      contains: async () => {
        throw new Error('404')
      },
    } as unknown as GithubTaskReader
    expect(await stackedOn(failing, merged, dependent)).toBeUndefined()
  })
})

describe('taskStack', () => {
  const context = (labels: string[], urls: string[]) => ({
    issue: { title: 't', html_url: 'https://github.com/o/r/issues/7', labels },
    blockers: urls.map((html_url, i) => ({ number: i, title: 't', state: 'open', html_url })),
  })

  it('sin el label, undefined', async () => {
    expect(
      await taskStack(reader(undefined), 'epic-early', dependent, context([], []), undefined),
    ).toBeUndefined()
  })

  it('un blocker cuya URL no es la de un issue sigue pendiente', async () => {
    const stack = await taskStack(
      reader(undefined),
      'epic-early',
      dependent,
      context(['epic-early'], ['https://github.example.com/o/r/issues/3']),
      undefined,
    )
    expect(stack?.pending).toEqual(['https://github.example.com/o/r/issues/3'])
    expect(refOfUrl('https://github.example.com/o/r/issues/3')).toBe(
      'https://github.example.com/o/r/issues/3',
    )
  })
})
