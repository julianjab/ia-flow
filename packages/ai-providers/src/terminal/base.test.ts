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
  it('lleva agente, task y título, en ese orden', () => {
    expect(tmuxSessionLabel(GH)).toBe('builder-task-1277-scoped-config-list-by-raw-rows')
  })

  it('distingue dos agentes sobre el MISMO issue', () => {
    expect(tmuxSessionLabel(GH)).not.toBe(tmuxSessionLabel({ ...GH, agentId: 'reviewer' }))
  })

  it('un título largo no se come al agente ni a la task', () => {
    const label = tmuxSessionLabel({ ...GH, taskTitle: 'a'.repeat(200) })
    expect(label.startsWith('builder-task-1277-')).toBe(true)
    expect(label.length).toBeLessThanOrEqual(80)
  })

  it('sin agente ni título sigue siendo un nombre tmux válido', () => {
    expect(tmuxSessionLabel({ taskId: 'abc123', taskTitle: '   ' })).toBe('task-abc123')
  })

  it('no deja caracteres que tmux trata como separadores', () => {
    const label = tmuxSessionLabel({ ...GH, taskTitle: 'fix: a.b:c $HOME' })
    expect(label).not.toMatch(/[.:\s$]/)
  })
})

describe('itermTabTitle', () => {
  it('`<agente>: task-<issue> — <título>`', () => {
    expect(itermTabTitle(GH)).toBe('builder: task-1277 — Scoped config list by raw rows')
  })

  it('recorta el título pero nunca el agente ni la task', () => {
    const title = itermTabTitle({ ...GH, taskTitle: 'x'.repeat(120) })
    expect(title.startsWith('builder: task-1277 — ')).toBe(true)
    expect(title.length).toBe('builder: task-1277 — '.length + 40)
  })

  it('sin agente cae a la task sola en vez de dejar un prefijo colgando', () => {
    expect(itermTabTitle({ ...GH, agentId: undefined })).toBe(
      'task-1277 — Scoped config list by raw rows',
    )
  })
})
