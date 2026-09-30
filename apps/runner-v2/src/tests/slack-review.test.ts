import { describe, expect, it, vi } from 'bun:test'
import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { SlackClient } from '@ia-flow/slack-api'
import { RequestSlackReviewAction } from '../../.config/actions/_lib/slack/RequestSlackReviewAction.js'

const TASK = { owner: 'la-haus', repo: 'subscriptions', number: 7, task: { branch: 'ia-flow/7' } }
const THREAD = 'https://x.slack.com/archives/CREV1/p1699999999123456'
const PROJECT = { slackReviewChannel: 'CREV1', slackReviewers: [{ id: 'U1' }] }

const ctx = (payload: Record<string, unknown> = TASK): PipelineExecutionContext => ({
  event: createEvent('issue.status_changed', payload),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'review',
})

function github(opts: {
  body?: string
  assignees?: string[]
  checks?: Array<{ status: string; conclusion: string | null }>
}) {
  const patched: string[] = []
  const requestJson = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'PATCH') {
      patched.push(JSON.parse(init.body ?? '{}').body)
      return {}
    }
    if (path.includes('/pulls?')) {
      return [
        {
          number: 12,
          title: 'Arregla X',
          html_url: 'https://github.com/pr/12',
          head: { sha: 'abc' },
        },
      ]
    }
    if (path.includes('/check-runs')) {
      return {
        check_runs: (opts.checks ?? [{ status: 'completed', conclusion: 'success' }]).map(
          (run) => ({
            name: 'ci',
            ...run,
          }),
        ),
      }
    }
    if (path.endsWith('/issues/7'))
      return {
        body: opts.body ?? 'El PRD',
        assignees: (opts.assignees ?? []).map((login) => ({ login })),
      }
    throw new Error(`no esperaba ${path}`)
  })
  return { client: { requestJson } as unknown as GithubClient, patched, requestJson }
}

function slack() {
  const posted: Array<Record<string, unknown>> = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('chat.postMessage')) {
      posted.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true, channel: 'CREV1', ts: '1699999999.123456' }))
    }
    return new Response(JSON.stringify({ ok: true, permalink: THREAD }))
  })
  return { client: new SlackClient({ token: 'xoxb', fetchImpl: fetchImpl as never }), posted }
}

const action = (
  gh: ReturnType<typeof github>,
  sl: ReturnType<typeof slack>,
  repo = {},
  users: Record<string, { id: string }> = {},
  project: Record<string, unknown> = PROJECT,
) =>
  new RequestSlackReviewAction({
    github: gh.client,
    slack: sl.client,
    project,
    users,
    repo: () => repo,
  })

describe('request_slack_review', () => {
  it('opens the thread with the PR of the task and saves its link in the issue body', async () => {
    const gh = github({})
    const sl = slack()

    const result = await action(gh, sl).run(ctx(), {})

    expect(result).toBe(`Review pedido en Slack: ${THREAD}`)
    expect(sl.posted[0]).toMatchObject({ channel: 'CREV1' })
    expect(String(sl.posted[0]?.text)).toContain('<@U1>')
    expect(String(sl.posted[0]?.text)).toContain('https://github.com/pr/12')
    expect(sl.posted[0]?.thread_ts).toBeUndefined()
    expect(gh.patched[0]).toContain('El PRD')
    expect(gh.patched[0]).toContain(`<!-- ia-flow:slack -->\n## Slack\n\n${THREAD}`)
  })

  it('answers inside the previous thread, and the repo overrides the project', async () => {
    const gh = github({
      body: `El PRD\n\n<!-- ia-flow:slack -->\n## Slack\n\n${THREAD}\n<!-- /ia-flow:slack -->`,
    })
    const sl = slack()

    const result = await action(gh, sl, { slackReviewers: [{ id: 'U9' }] }).run(ctx(), {})

    expect(result).toBe(`Re-review pedido en el hilo: ${THREAD}`)
    expect(sl.posted[0]).toMatchObject({ thread_ts: '1699999999.123456' })
    expect(String(sl.posted[0]?.text)).toContain('<@U9>')
    expect(gh.patched).toEqual([])
  })

  it('does not post while the CI runs, nor on red CI unless allowed', async () => {
    const sl = slack()
    await expect(
      action(github({ checks: [{ status: 'in_progress', conclusion: null }] }), sl).run(ctx(), {}),
    ).rejects.toThrow(/todavía corre/)
    const red = github({ checks: [{ status: 'completed', conclusion: 'failure' }] })
    await expect(action(red, sl).run(ctx(), {})).rejects.toThrow(/rojo/)
    expect(sl.posted).toEqual([])
    await action(red, sl).run(ctx(), { allowFailedCi: true })
    expect(sl.posted).toHaveLength(1)
  })

  it('without a channel or reviewers, or without Slack, it says why', async () => {
    const gh = github({})
    const noChannel = new RequestSlackReviewAction({
      github: gh.client,
      slack: slack().client,
      project: {},
      repo: () => undefined,
    })
    await expect(noChannel.run(ctx(), {})).rejects.toThrow(/canal/)
    const off = new RequestSlackReviewAction({
      github: gh.client,
      slack: new SlackClient({ token: () => undefined }),
      project: PROJECT,
      repo: () => undefined,
    })
    await expect(off.run(ctx(), {})).rejects.toThrow(/SLACK_BOT_TOKEN/)
  })
})

describe('request_slack_review: the assignee', () => {
  const users = { julianjab: { id: 'UJULI' } }

  it('tags the assignee of the issue and the configured reviewers', async () => {
    const gh = github({ assignees: ['JulianJab'] })
    const sl = slack()
    await action(gh, sl, {}, users).run(ctx(), {})
    expect(String(sl.posted[0]?.text)).toContain('<@UJULI> <@U1>')
  })

  it('tags only the configured reviewers when the assignee is not in slack.users', async () => {
    const gh = github({ assignees: ['otro'] })
    const sl = slack()
    await action(gh, sl, {}, users).run(ctx(), {})
    const text = String(sl.posted[0]?.text)
    expect(text).toContain('<@U1>')
    expect(text).not.toContain('UJULI')
  })

  it('says who is missing from slack.users when there is nobody else to tag', async () => {
    const gh = github({ assignees: ['otro'] })
    const sl = slack()
    const project = { slackReviewChannel: 'CREV1' }
    await expect(action(gh, sl, {}, users, project).run(ctx(), {})).rejects.toThrow(
      /otro.*slack\.users/,
    )
    expect(sl.posted).toEqual([])
  })

  it('tags the assignee in the re-review too', async () => {
    const gh = github({
      assignees: ['julianjab'],
      body: `<!-- ia-flow:slack -->\n## Slack\n\n${THREAD}\n<!-- /ia-flow:slack -->`,
    })
    const sl = slack()
    await action(gh, sl, {}, users).run(ctx(), {})
    expect(String(sl.posted[0]?.text)).toContain('<@UJULI>')
    expect(sl.posted[0]?.thread_ts).toBeDefined()
  })
})
