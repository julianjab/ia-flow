import { describe, expect, it } from 'bun:test'
import type { Task } from '@ia-flow/shared'
import { atCap, countRunningByAgent, countRunningByProvider, isUnlimited } from '../capacity.js'
import type { PendingTask } from '../pending-tasks.js'

function pending(overrides: Partial<PendingTask>): [string, PendingTask] {
  const task = { id: 't', title: 't', status: 'Build' } as Task
  return [
    (overrides.task?.id ?? 't') as string,
    {
      task,
      manager: {} as PendingTask['manager'],
      broadcast: () => {},
      initialStatus: 'Build',
      ...overrides,
    } as PendingTask,
  ]
}

describe('isUnlimited / atCap', () => {
  it('un cap ausente no limita', () => {
    expect(isUnlimited(undefined)).toBe(true)
    expect(atCap(99, undefined)).toBe(false)
  })

  it('un cap de 0 se trata como "sin definir", no como "frenar todo"', () => {
    // Misma decisión que el knob de env — un 0 que congela cada dispatch deja
    // el item difiriéndose contra una condición que nunca puede despejarse.
    expect(isUnlimited(0)).toBe(true)
    expect(atCap(0, 0)).toBe(false)
    expect(atCap(50, 0)).toBe(false)
  })

  it('satura recién al alcanzar el cap, no antes', () => {
    expect(atCap(1, 2)).toBe(false)
    expect(atCap(2, 2)).toBe(true)
    expect(atCap(3, 2)).toBe(true)
  })
})

describe('countRunningByAgent / countRunningByProvider', () => {
  const snapshot = () => [
    pending({ agentId: 'builder', providerId: 'anthropic-api' }),
    pending({ agentId: 'builder', providerId: 'tmux-claude' }),
    pending({ agentId: 'reviewer', providerId: 'anthropic-api' }),
    pending({ agentId: 'reviewer' }),
  ]

  it('cuenta por agente', () => {
    expect(countRunningByAgent('builder', snapshot)).toBe(2)
    expect(countRunningByAgent('reviewer', snapshot)).toBe(2)
    expect(countRunningByAgent('nadie', snapshot)).toBe(0)
  })

  it('cuenta por provider, cruzando agentes', () => {
    expect(countRunningByProvider('anthropic-api', snapshot)).toBe(2)
    expect(countRunningByProvider('tmux-claude', snapshot)).toBe(1)
  })

  it('una entrada sin providerId no cuenta para ningún provider', () => {
    expect(countRunningByProvider('undefined', snapshot)).toBe(0)
  })
})
