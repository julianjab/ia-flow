import { describe, expect, it } from 'bun:test'
import type { AssistantScope, AssistantStreamEvent, InboxItem, InboxProject } from '@ia-flow/shared'
import { type AssistantBackend, AssistantSession } from './AssistantSession.js'

const blocked: InboxItem = {
  ref: 'o/r#1',
  project_id: 'p',
  title: 'Trabada',
  url: 'https://github.com/o/r/issues/1',
  group: 'need',
  kind: 'doubt',
  status: 'Build',
  labels: ['blocked'],
  why: 'El implementer preguntó',
  since: '2026-10-16T10:00:00Z',
  actions: ['answer_and_unblock'],
}

const running: InboxItem = {
  ...blocked,
  ref: 'o/r#3',
  group: 'run',
  kind: 'agent',
  labels: [],
  execution: {
    id: 'e1',
    pipeline_id: 'build',
    status: 'running',
    started_at: '2026-10-16T10:00:00Z',
  },
}

const p: InboxProject = {
  id: 'p',
  board: { owner: 'o', number: 1 },
  url: 'u',
  board_url: 'u',
  statuses: ['Todo', 'Refine', 'Build', 'Review'],
}

function session(
  scope: AssistantScope,
  options: { projects?: InboxProject[]; origin?: boolean } = {},
) {
  const items = [blocked, running]
  const events: AssistantStreamEvent[] = []
  const backend = {
    inbox: {
      inbox: async () => ({ items, projects: options.projects ?? [p] }),
      item: async (ref: string) => items.find((item) => item.ref === ref),
    },
  } as unknown as AssistantBackend
  const created = new AssistantSession(
    scope,
    backend,
    (event) => events.push(event),
    options.origin ? { agent: 'retrospective' } : undefined,
  )
  const proposals = () =>
    events.flatMap((event) => (event.type === 'proposal' ? [event.proposal] : []))
  return { board: created.board, proposals }
}

describe('proposing to move a card', () => {
  it('shows the move with the column it comes from, without moving anything', async () => {
    const { board, proposals } = session({ kind: 'general' })
    await expect(
      board.move({ ref: 'o/r#1', status: 'Refine', reason: 'falta el PRD' }),
    ).resolves.toContain('NO está hecha')
    expect(proposals()).toEqual([
      {
        id: expect.any(String),
        kind: 'move',
        ref: 'o/r#1',
        status: 'Refine',
        from: 'Build',
        label: 'Mover a Refine',
        reason: 'falta el PRD',
      },
    ])
  })

  it('refuses a column the board does not have, the one it is in, and a card with an agent working', async () => {
    const { board, proposals } = session({ kind: 'general' })
    await expect(board.move({ ref: 'o/r#1', status: 'Done' })).rejects.toThrow(
      'Todo, Refine, Build, Review',
    )
    await expect(board.move({ ref: 'o/r#1', status: 'Build' })).rejects.toThrow('ya está en Build')
    await expect(board.move({ ref: 'o/r#3', status: 'Review' })).rejects.toThrow('stop')
    expect(proposals()).toEqual([])
  })

  it('in the context of a task, only that task', async () => {
    const { board } = session({ kind: 'task', ref: 'o/r#3' })
    await expect(board.move({ ref: 'o/r#1', status: 'Refine' })).rejects.toThrow(
      'Fuera de contexto',
    )
  })

  it('a pipeline session proposes nothing to the board: nobody is looking', async () => {
    const { board } = session({ kind: 'task', ref: 'o/r#1' }, { origin: true })
    await expect(board.move({ ref: 'o/r#1', status: 'Refine' })).rejects.toThrow(
      'Fuera de una conversación',
    )
  })
})

describe('proposing to add an issue to the board', () => {
  it('takes the link or the ref, and the only project of the runner', async () => {
    const { board, proposals } = session({ kind: 'general' })
    await board.addToBoard({
      issue: 'https://github.com/o/r/issues/7',
      status: 'Refine',
      reason: 'lo pidió producto',
    })
    await board.addToBoard({ issue: 'o/r#8', reason: 'sigue' })
    expect(proposals()).toEqual([
      {
        id: expect.any(String),
        kind: 'add_to_board',
        issue: 'o/r#7',
        project_id: 'p',
        status: 'Refine',
        label: 'Agregar al board en Refine',
        reason: 'lo pidió producto',
      },
      {
        id: expect.any(String),
        kind: 'add_to_board',
        issue: 'o/r#8',
        project_id: 'p',
        label: 'Agregar al board',
        reason: 'sigue',
      },
    ])
  })

  it('refuses one already on the board, a column the board does not have, and something that is not an issue', async () => {
    const { board, proposals } = session({ kind: 'general' })
    await expect(board.addToBoard({ issue: 'o/r#1' })).rejects.toThrow(
      'ya está en el board (en Build)',
    )
    await expect(board.addToBoard({ issue: 'o/r#7', status: 'Done' })).rejects.toThrow(
      'no es una columna',
    )
    await expect(board.addToBoard({ issue: 'r#7' })).rejects.toThrow('no es owner/repo#n')
    expect(proposals()).toEqual([])
  })

  it('asks for the project when the runner has more than one, and keeps the one of the context', async () => {
    const q = { ...p, id: 'q' }
    const general = session({ kind: 'general' }, { projects: [p, q] })
    await expect(general.board.addToBoard({ issue: 'o/r#7' })).rejects.toThrow('¿A qué proyecto?')
    await general.board.addToBoard({ issue: 'o/r#7', project_id: 'q' })
    expect(general.proposals()[0]).toMatchObject({ project_id: 'q' })

    const scoped = session({ kind: 'project', project_id: 'p' }, { projects: [p] })
    await expect(scoped.board.addToBoard({ issue: 'o/r#7', project_id: 'q' })).rejects.toThrow(
      'Fuera de contexto',
    )
  })

  it('in the context of a task, only that task', async () => {
    const { board } = session({ kind: 'task', ref: 'o/r#5' })
    await expect(board.addToBoard({ issue: 'o/r#7' })).rejects.toThrow('Fuera de contexto')
    await expect(board.addToBoard({ issue: 'o/r#5' })).resolves.toContain('NO está hecha')
  })
})

describe('proposing to change labels', () => {
  it('shows what goes and what comes off, as the button says it', async () => {
    const { board, proposals } = session({ kind: 'task', ref: 'o/r#1' })
    await board.labels({ ref: 'o/r#1', remove: ['blocked'], reason: 'ya se contestó' })
    await board.labels({ ref: 'o/r#1', add: ['e2e-test', 'e2e-test'], remove: ['blocked'] })
    expect(proposals()).toEqual([
      {
        id: expect.any(String),
        kind: 'labels',
        ref: 'o/r#1',
        remove: ['blocked'],
        label: 'Sacar blocked',
        reason: 'ya se contestó',
      },
      {
        id: expect.any(String),
        kind: 'labels',
        ref: 'o/r#1',
        add: ['e2e-test'],
        remove: ['blocked'],
        label: 'Poner e2e-test y sacar blocked',
        reason: '',
      },
    ])
  })

  it('refuses nothing to change, a label it already has or lacks, and the same label both ways', async () => {
    const { board, proposals } = session({ kind: 'general' })
    await expect(board.labels({ ref: 'o/r#1' })).rejects.toThrow('Pasá qué labels')
    await expect(board.labels({ ref: 'o/r#1', add: ['blocked'] })).rejects.toThrow(
      'ya tiene blocked',
    )
    await expect(board.labels({ ref: 'o/r#1', remove: ['reviewed'] })).rejects.toThrow(
      'no tiene reviewed. Tiene: blocked',
    )
    await expect(board.labels({ ref: 'o/r#1', add: ['x'], remove: ['x'] })).rejects.toThrow(
      'No las dos',
    )
    expect(proposals()).toEqual([])
  })

  it('in the context of a task, only that task', async () => {
    const { board } = session({ kind: 'task', ref: 'o/r#3' })
    await expect(board.labels({ ref: 'o/r#1', remove: ['blocked'] })).rejects.toThrow(
      'Fuera de contexto',
    )
  })
})
