import { describe, expect, it } from 'bun:test'
import type { GithubClient } from '@ia-flow/github-api'
import { IssueLabelFields } from './IssueLabelFields.js'
import type { LabelScheme } from './labelScheme.js'

const scheme: LabelScheme = { prefix: 'status:', statuses: ['Todo', 'Refine', 'Build', 'Done'] }
const issue = { owner: 'julianjab', repo: 'ia-flow', number: 255 }

/** GitHub de mentira: el issue tiene `labels` y cada llamada se anota, en orden. */
function github(labels: string[], extra: Record<string, unknown> = {}) {
  const calls: string[] = []
  const client = {
    requestJson: async (path: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${path} ${init.body ?? ''}`.trim())
      return { labels: labels.map((name) => ({ name })), ...extra }
    },
    request: async (path: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${path}`)
      return { ok: true, status: 204 }
    },
  } as unknown as GithubClient
  return { client, calls }
}

describe('IssueLabelFields.setFields', () => {
  it('adds the new status BEFORE taking the old one off, so the card is never without one', async () => {
    const { client, calls } = github(['bug', 'status:refine'])
    await new IssueLabelFields(client, scheme).setFields(issue, { Status: 'Build' })
    expect(calls).toEqual([
      'GET /repos/julianjab/ia-flow/issues/255',
      'POST /repos/julianjab/ia-flow/issues/255/labels {"labels":["status:build"]}',
      'DELETE /repos/julianjab/ia-flow/issues/255/labels/status%3Arefine',
    ])
  })

  it('does nothing when the card is already there', async () => {
    const { client, calls } = github(['status:build'])
    await new IssueLabelFields(client, scheme).setFields(issue, { Status: 'build' })
    expect(calls).toEqual(['GET /repos/julianjab/ia-flow/issues/255'])
  })

  it('rejects a column that is not declared, before touching GitHub', async () => {
    const { client, calls } = github([])
    await expect(
      new IssueLabelFields(client, scheme).setFields(issue, { Status: 'Archived' }),
    ).rejects.toThrow(
      /"Archived" no es una opción de "Status" — opciones: Todo, Refine, Build, Done/,
    )
    expect(calls).toEqual([])
  })

  it('sets the working marker and clears it', async () => {
    const on = github(['status:build'])
    await new IssueLabelFields(on.client, scheme).setFields(issue, { Working: 'Yes' })
    expect(on.calls.at(1)).toContain('"labels":["working:yes"]')

    const off = github(['status:build', 'working:yes'])
    await new IssueLabelFields(off.client, scheme).setFields(issue, {}, ['Working'])
    expect(off.calls).toEqual([
      'GET /repos/julianjab/ia-flow/issues/255',
      'DELETE /repos/julianjab/ia-flow/issues/255/labels/working%3Ayes',
    ])
  })

  it('tolerates a label that is already gone (404)', async () => {
    const calls: string[] = []
    const client = {
      requestJson: async () => ({ labels: [{ name: 'working:yes' }] }),
      request: async (path: string) => {
        calls.push(path)
        return { ok: false, status: 404 }
      },
    } as unknown as GithubClient
    await new IssueLabelFields(client, scheme).setFields(issue, {}, ['Working'])
    expect(calls).toHaveLength(1)
  })

  it('refuses a path that is not owner/repo/number', async () => {
    const { client } = github([])
    await expect(
      new IssueLabelFields(client, scheme).setFields(
        { owner: '../orgs', repo: 'x', number: 1 },
        { Status: 'Build' },
      ),
    ).rejects.toThrow(/"owner" inválido/)
  })
})

describe('IssueLabelFields.read', () => {
  it('says when the "issue" is really a pull request', async () => {
    const { client } = github(['x'], { pull_request: { url: 'u' } })
    expect(await new IssueLabelFields(client, scheme).read(issue)).toEqual({
      labels: ['x'],
      isPullRequest: true,
    })
  })
})

describe('IssueLabelFields when taking the old label off fails', () => {
  /** El DELETE de `failing` responde 500; los demás, 204. Anota todo, en orden. */
  function flaky(labels: string[], failing: string[]) {
    const calls: string[] = []
    const client = {
      requestJson: async (path: string, init: RequestInit = {}) => {
        calls.push(`${init.method ?? 'GET'} ${path} ${init.body ?? ''}`.trim())
        return { labels: labels.map((name) => ({ name })) }
      },
      request: async (path: string, init: RequestInit = {}) => {
        calls.push(`${init.method} ${path}`)
        const hit = failing.some((label) => path.endsWith(`/labels/${encodeURIComponent(label)}`))
        return { ok: !hit, status: hit ? 500 : 204 }
      },
    } as unknown as GithubClient
    return { client, calls }
  }

  it('undoes the move, so a step back (Review → Build) is not read as still Review', async () => {
    const { client, calls } = flaky(['status:done'], ['status:done'])
    await expect(
      new IssueLabelFields(client, scheme).setFields(issue, { Status: 'Build' }),
    ).rejects.toThrow(/no se pudo sacar "status:done" → 500 \(cambio deshecho\)/)
    expect(calls).toEqual([
      'GET /repos/julianjab/ia-flow/issues/255',
      'POST /repos/julianjab/ia-flow/issues/255/labels {"labels":["status:build"]}',
      'DELETE /repos/julianjab/ia-flow/issues/255/labels/status%3Adone',
      // El rollback: saca el que agregó.
      'DELETE /repos/julianjab/ia-flow/issues/255/labels/status%3Abuild',
    ])
  })

  it('puts back what it had already taken off', async () => {
    const { client, calls } = flaky(['status:refine', 'working:yes'], ['working:yes'])
    await expect(
      new IssueLabelFields(client, scheme).setFields(issue, { Status: 'Build' }, ['Working']),
    ).rejects.toThrow(/cambio deshecho/)
    // sacó status:refine, falló working:yes → devuelve status:refine y saca status:build
    expect(calls.slice(-2)).toEqual([
      'POST /repos/julianjab/ia-flow/issues/255/labels {"labels":["status:refine"]}',
      'DELETE /repos/julianjab/ia-flow/issues/255/labels/status%3Abuild',
    ])
  })

  it('says so when it could not even undo', async () => {
    const { client } = flaky(['status:done'], ['status:done', 'status:build'])
    await expect(
      new IssueLabelFields(client, scheme).setFields(issue, { Status: 'Build' }),
    ).rejects.toThrow(
      /no se pudo deshacer: la card puede tener status:build y status:done a la vez/,
    )
  })
})
