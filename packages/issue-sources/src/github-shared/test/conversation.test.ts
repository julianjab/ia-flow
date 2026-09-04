import { describe, expect, it } from 'bun:test'
import type { PullRequestRef } from '@ia-flow/shared'
import { postToTarget } from '../conversation.js'
import { openPullRequests } from '../dev-links.js'

// `fetchConversation` y `postToTarget` hacen I/O (gql) y se cubren en los
// tests de cada source; lo que se testea acá es la regla pura que decide qué
// PRs entran en juego, que es la que gobierna las DOS direcciones.
describe('openPullRequests', () => {
  const pr = (over: Partial<PullRequestRef>): PullRequestRef => ({
    number: 1,
    url: 'https://github.com/o/r/pull/1',
    state: 'open',
    isDraft: false,
    nodeId: 'PR_1',
    ...over,
  })

  it('deja pasar los abiertos', () => {
    expect(openPullRequests([pr({})])).toHaveLength(1)
  })

  // Comentar en un PR mergeado es carta muerta, y leer los comentarios de un
  // intento abandonado compite con el intento vivo.
  it('descarta cerrados y mergeados', () => {
    const prs = [pr({ number: 1, state: 'closed' }), pr({ number: 2, state: 'merged' })]
    expect(openPullRequests(prs)).toEqual([])
  })

  // Un draft está abierto y es donde está el trabajo.
  it('incluye los draft', () => {
    expect(openPullRequests([pr({ isDraft: true })])).toHaveLength(1)
  })

  // Sin node id no se puede ni comentar (`addComment(subjectId:)`) ni leer
  // (`nodes(ids:)`), así que un ref viejo cacheado sin él no sirve para nada.
  it('descarta los que no traen nodeId', () => {
    expect(openPullRequests([pr({ nodeId: undefined })])).toEqual([])
  })

  it('tolera ausencia de PRs', () => {
    expect(openPullRequests(undefined)).toEqual([])
  })
})

// `postToTarget` con `none` corta ANTES de la mutación `gql` — el único caso
// que se puede testear sin mockear I/O. El resto de los targets se cubren en
// los tests de cada source (github-issues/github-project), que sí mockean
// `gql`.
describe('postToTarget · none', () => {
  it('no publica nada y no explota sin mockear gql', async () => {
    await expect(postToTarget('ISSUE_1', 'body', 'none')).resolves.toEqual({ subject: 'none' })
  })
})
