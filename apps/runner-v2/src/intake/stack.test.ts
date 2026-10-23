import { describe, expect, it } from 'bun:test'
import type { GithubTaskReader } from '@ia-flow/github-tools'
import { stackedOn } from './stack.js'

const merged = { owner: 'o', repo: 'r', head: 'feat/a', headSha: 'abc', base: 'main' }
const dependent = { owner: 'o', repo: 'r', number: 7 }

function reader(baseRef: string | undefined, carries = false) {
  return {
    openPullRequest: async () =>
      baseRef === undefined ? undefined : { number: 70, headRef: 'feat/b', baseRef },
    contains: async () => carries,
    stackBlockers: async () => [],
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
