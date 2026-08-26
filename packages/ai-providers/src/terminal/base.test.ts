import { describe, expect, it } from 'bun:test'
import { itermTabTitle, taskLabel, tmuxSessionLabel } from './base.js'

const GH = {
  agentId: 'builder',
  taskId: 'PVTI_lAHOAIgSic4Bf4pzzg3fXxk',
  taskTitle: 'Scoped config list by raw rows',
  issueNumber: 1277,
}

describe('taskLabel', () => {
  it('usa el número de issue — la misma forma que nombra el worktree', () => {
    expect(taskLabel(GH)).toBe('task-1277')
  })

  it('sin issueNumber cae al sufijo del id, nunca al node id completo', () => {
    const label = taskLabel({ ...GH, issueNumber: undefined })
    expect(label).toBe('task-g3fxxk')
    expect(label).not.toContain('pvti')
  })
})

describe('tmuxSessionLabel', () => {
  it('lleva agente y task, en ese orden', () => {
    expect(tmuxSessionLabel(GH)).toBe('builder-task-1277')
  })

  it('distingue dos agentes sobre el MISMO issue', () => {
    expect(tmuxSessionLabel(GH)).not.toBe(tmuxSessionLabel({ ...GH, agentId: 'reviewer' }))
  })

  it('no arrastra el título del issue por más largo que sea', () => {
    expect(tmuxSessionLabel({ ...GH, taskTitle: 'a'.repeat(200) })).toBe('builder-task-1277')
  })

  it('sin agente sigue siendo un nombre tmux válido', () => {
    expect(tmuxSessionLabel({ taskId: 'abc123', taskTitle: '   ' })).toBe('task-abc123')
  })

  it('no deja caracteres que tmux trata como separadores de target', () => {
    const label = tmuxSessionLabel({ ...GH, agentId: 'build.er:1' })
    expect(label).not.toMatch(/[.:\s$]/)
  })
})

describe('itermTabTitle', () => {
  it('`<agente>: task-<issue>`', () => {
    expect(itermTabTitle(GH)).toBe('builder: task-1277')
  })

  it('no arrastra el título del issue por más largo que sea', () => {
    expect(itermTabTitle({ ...GH, taskTitle: 'x'.repeat(120) })).toBe('builder: task-1277')
  })

  it('sin agente cae a la task sola en vez de dejar un prefijo colgando', () => {
    expect(itermTabTitle({ ...GH, agentId: undefined })).toBe('task-1277')
  })
})
