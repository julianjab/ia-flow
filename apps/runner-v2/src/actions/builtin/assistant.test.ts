import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import type { Action, PipelineExecutionContext } from '@ia-flow/agent-engine'
import { AssistantDesk } from '../../assistant/AssistantDesk.js'
import type { ActivityPort } from '../../inbox/ActivityPort.js'
import type { InboxService } from '../../inbox/InboxService.js'
import { SqliteImprovementStore } from '../../storage/SqliteImprovementStore.js'
import type { ActionContext } from '../defineAction.js'
import assistantActions from './assistant.js'

/** Una tarea cuyo issue ya se cerró con el merge: no está en el board, pero corrió. */
const activity = {
  executions: () => [{ id: 'exec-1', status: 'done' }],
  eventsForTask: () => [{ type: 'pull_request' }],
  trace: () => [{ name: 'agent implementer', attributes: {} }],
  recentEvents: () => [],
} as unknown as ActivityPort

const inbox = {
  item: async () => undefined,
  detail: async () => undefined,
  explain: async () => undefined,
  inbox: async () => ({ items: [] }),
} as unknown as Pick<InboxService, 'inbox' | 'item' | 'detail' | 'explain'>

function mount(options: Record<string, unknown> = { engine: 'julianjab/ia-flow' }) {
  const improvements = new SqliteImprovementStore(new Database(':memory:'))
  const desk = new AssistantDesk()
  desk.connect({
    inbox,
    activity,
    config: () => ({ projects: [], pipelines: [], agents: [], providers: [], mcp: [] }),
    status: () => ({}),
    improvements,
  })
  const ctx = { services: { assistant: desk }, agentId: 'retrospective', options } as ActionContext
  const tools = assistantActions.flatMap((definition) =>
    [definition.create(ctx)].flat(),
  ) as Action[]
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.id === name)
    if (!found) throw new Error(`falta ${name}`)
    return found
  }
  return { improvements, tool }
}

/** El evento de la pipeline: el `pull_request` mergeado de la tarea. */
const run = {
  event: {
    type: 'pull_request',
    payload: { task: { id: 'o/r#1' }, pr: { url: 'https://github.com/o/r/pull/9' } },
  },
  execution: { id: 'exec-9' },
} as unknown as PipelineExecutionContext

const proposal = {
  title: 'Documentar el lint',
  body: '## Problema\nx',
  reason: 'costó tres vueltas',
}

describe('the assistant tools in the pipeline of a task', () => {
  it('a docs improvement goes to the repo of the task, pending in the inbox', async () => {
    const { improvements, tool } = mount()
    const said = await tool('propose_improvement').execute({ target: 'docs', ...proposal }, run)
    expect(said).toContain('guardada en la bandeja')
    expect(improvements.list('open')).toEqual([
      expect.objectContaining({
        task_ref: 'o/r#1',
        pr_url: 'https://github.com/o/r/pull/9',
        agent: 'retrospective',
        execution_id: 'exec-9',
        target: 'docs',
        repo: 'o/r',
        title: 'Documentar el lint',
      }),
    ])
  })

  it('engine and config go to the repos the agent was given; one not given is refused', async () => {
    const { improvements, tool } = mount({ engine: 'o/engine', config: 'o/deploy' })
    await tool('propose_improvement').execute({ target: 'engine', ...proposal }, run)
    await tool('propose_improvement').execute(
      { target: 'config', ...proposal, title: 'Subir maxToolRounds' },
      run,
    )
    expect(
      improvements
        .list()
        .map((p) => p.repo)
        .sort(),
    ).toEqual(['o/deploy', 'o/engine'])

    const bare = mount({})
    await expect(
      bare.tool('propose_improvement').execute({ target: 'config', ...proposal }, run),
    ).rejects.toThrow(/no declaró el repo de `config`/)
  })

  it('does not repeat one already pending, and lists what is pending', async () => {
    const { improvements, tool } = mount()
    await tool('propose_improvement').execute({ target: 'docs', ...proposal }, run)
    const again = await tool('propose_improvement').execute(
      { target: 'docs', ...proposal, title: 'documentar el LINT' },
      run,
    )
    expect(again).toContain('Ya hay una propuesta igual')
    expect(improvements.list()).toHaveLength(1)
    expect(JSON.parse(String(await tool('list_improvements').execute({}, run)))).toEqual([
      expect.objectContaining({ task_ref: 'o/r#1', target: 'docs', repo: 'o/r' }),
    ])
  })

  it('reads the task although it left the board, and only that task', async () => {
    const { tool } = mount()
    const detail = JSON.parse(
      String(await tool('assistant_get_task').execute({ ref: 'o/r#1' }, run)),
    )
    expect(detail.executions).toEqual([{ id: 'exec-1', status: 'done' }])
    expect(detail.item).toMatchObject({ ref: 'o/r#1' })
    await expect(tool('assistant_get_task').execute({ ref: 'o/r#2' }, run)).rejects.toThrow(
      /Fuera de contexto/,
    )
  })

  it('does not propose actions on a task: nobody is there to confirm them', async () => {
    const { tool } = mount()
    await expect(
      tool('assistant_propose_action').execute({ ref: 'o/r#1', action: 'merge', reason: 'x' }, run),
    ).rejects.toThrow(/no se proponen acciones/)
  })

  it('outside a request and outside the pipeline of a task, it says why', async () => {
    const { tool } = mount()
    const loose = { event: { type: 'x', payload: {} } } as unknown as PipelineExecutionContext
    await expect(tool('list_improvements').execute({}, loose)).rejects.toThrow(
      /pipeline de una tarea/,
    )
  })
})
