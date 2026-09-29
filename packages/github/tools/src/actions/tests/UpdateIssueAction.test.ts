import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { UpdateIssueAction } from '../UpdateIssueAction.js'

interface Call {
  method: string
  url: string
  body?: { query?: string; variables?: Record<string, unknown>; [key: string]: unknown }
}

const ISSUE = { owner: 'la-haus', repo: 'subscriptions', number: 42 }

function ctxFor(payload: Record<string, unknown> = ISSUE): PipelineExecutionContext {
  return { event: createEvent('e', payload), steps: {}, bus: new EventBus(), pipelineId: 'p' }
}

/** Un GitHub falso: el proyecto la-haus#7 con los campos Status y Task Type. */
function fakeGithub(options: { inProject?: boolean; labelDeleteStatus?: number } = {}) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined
    calls.push({ method: init.method ?? 'GET', url, body })
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

    if (url.endsWith('/graphql')) {
      if (body.query.includes('projectItems')) {
        const nodes =
          options.inProject === false
            ? []
            : [{ id: 'ITEM', project: { id: 'PROJ', number: 7, owner: { login: 'La-Haus' } } }]
        return json({ data: { repository: { issue: { projectItems: { nodes } } } } })
      }
      if (body.query.includes('fields(')) {
        return json({
          data: {
            node: {
              fields: {
                nodes: [
                  {},
                  {
                    id: 'F_STATUS',
                    name: 'Status',
                    options: [
                      { id: 'O_BUILD', name: 'Build' },
                      { id: 'O_REVIEW', name: 'Review' },
                    ],
                  },
                  {
                    id: 'F_TYPE',
                    name: 'Task Type',
                    options: [{ id: 'O_TECH', name: 'Technical' }],
                  },
                ],
              },
            },
          },
        })
      }
      return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM' } } } })
    }
    if (init.method === 'DELETE') {
      return new Response('{}', { status: options.labelDeleteStatus ?? 200 })
    }
    return json({})
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { client, calls }
}

const mutations = (calls: Call[]) =>
  calls.filter((call) => call.body?.query?.includes('updateProjectV2ItemFieldValue'))

describe('UpdateIssueAction', () => {
  it('moves the issue to a board column through the Project v2 Status field', async () => {
    const { client, calls } = fakeGithub()
    const action = new UpdateIssueAction({ client, project: { owner: 'la-haus', number: 7 } })

    const result = await action.run(ctxFor(), { status: 'build' })

    expect(result).toBe('la-haus/subscriptions#42: Status=build')
    expect(mutations(calls).map((call) => call.body?.variables)).toEqual([
      { projectId: 'PROJ', itemId: 'ITEM', fieldId: 'F_STATUS', optionId: 'O_BUILD' },
    ])
    expect(calls[0]?.body?.variables).toEqual({
      owner: 'la-haus',
      repo: 'subscriptions',
      number: 42,
    })
  })

  it('sets other single-select fields by name, case-insensitively', async () => {
    const { client, calls } = fakeGithub()
    const action = new UpdateIssueAction({ client, project: { owner: 'la-haus', number: 7 } })

    await action.run(ctxFor(), { fields: { 'task type': 'TECHNICAL' } })

    expect(mutations(calls)[0]?.body?.variables).toMatchObject({
      fieldId: 'F_TYPE',
      optionId: 'O_TECH',
    })
  })

  it('adds and removes labels, tolerating a label that was already gone', async () => {
    const { client, calls } = fakeGithub({ labelDeleteStatus: 404 })
    const action = new UpdateIssueAction({ client })

    const result = await action.run(ctxFor(), {
      addLabels: ['blocked'],
      removeLabels: ['ci checked'],
    })

    expect(result).toBe('la-haus/subscriptions#42: +blocked, -ci checked')
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://api.github.com/repos/la-haus/subscriptions/issues/42/labels',
      'DELETE https://api.github.com/repos/la-haus/subscriptions/issues/42/labels/ci%20checked',
    ])
    expect(calls[0]?.body).toEqual({ labels: ['blocked'] })
  })

  it('fails when removing a label errors with something other than 404', async () => {
    const { client } = fakeGithub({ labelDeleteStatus: 500 })

    await expect(
      new UpdateIssueAction({ client }).run(ctxFor(), { removeLabels: ['x'] }),
    ).rejects.toThrow('no se pudo sacar "x" → 500')
  })

  it('opens or closes the issue', async () => {
    const { client, calls } = fakeGithub()

    await new UpdateIssueAction({ client }).run(ctxFor(), { state: 'closed' })

    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: 'https://api.github.com/repos/la-haus/subscriptions/issues/42',
      body: { state: 'closed' },
    })
  })

  it('reports no changes for an empty input', async () => {
    const { client, calls } = fakeGithub()

    expect(await new UpdateIssueAction({ client }).run(ctxFor(), {})).toBe(
      'la-haus/subscriptions#42: sin cambios',
    )
    expect(calls).toEqual([])
  })

  it('refuses status/fields without a project configured', async () => {
    const { client } = fakeGithub()

    await expect(
      new UpdateIssueAction({ client }).run(ctxFor(), { status: 'Build' }),
    ).rejects.toThrow('status/fields necesitan un Project v2')
  })

  it('fails clearly when the issue is not in the project', async () => {
    const { client } = fakeGithub({ inProject: false })
    const action = new UpdateIssueAction({ client, project: { owner: 'la-haus', number: 7 } })

    await expect(action.run(ctxFor(), { status: 'Build' })).rejects.toThrow(
      'la-haus/subscriptions#42 no está en el proyecto la-haus#7',
    )
  })

  it('lists the valid options when the value does not exist', async () => {
    const { client } = fakeGithub()
    const action = new UpdateIssueAction({ client, project: { owner: 'la-haus', number: 7 } })

    await expect(action.run(ctxFor(), { status: 'Shipped' })).rejects.toThrow(
      '"Shipped" no es una opción de "Status" — opciones: Build, Review',
    )
  })

  it('fails for a field the project does not have', async () => {
    const { client } = fakeGithub()
    const action = new UpdateIssueAction({ client, project: { owner: 'la-haus', number: 7 } })

    await expect(action.run(ctxFor(), { fields: { Priority: 'High' } })).rejects.toThrow(
      'no tiene un campo single-select "Priority"',
    )
  })

  it('acts on the issue from the event, and a custom resolver can change where it comes from', async () => {
    const { client, calls } = fakeGithub()
    const action = new UpdateIssueAction({
      client,
      issue: () => ({ owner: 'o', repo: 'r', number: 1 }),
    })

    await action.run(ctxFor({}), { state: 'open' })

    expect(calls[0]?.url).toBe('https://api.github.com/repos/o/r/issues/1')
  })

  it('fails when the event does not carry the issue and no resolver is given', async () => {
    const { client } = fakeGithub()

    await expect(new UpdateIssueAction({ client }).run(ctxFor({}), {})).rejects.toThrow(
      'el evento no trae owner/repo/number',
    )
  })

  it('bound as a route destination, the model only fills what the operator left open', () => {
    const { client } = fakeGithub()
    const toBuild = new UpdateIssueAction({ client }).bind({ status: 'Build' })

    expect(Object.keys(toBuild.input.shape).sort()).toEqual([
      'addLabels',
      'fields',
      'removeLabels',
      'state',
    ])
  })
})
