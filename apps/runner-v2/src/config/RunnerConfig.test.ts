import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRunnerConfig, runnerPathOf } from './RunnerConfig.js'

/** Una config mínima en el tmp del sistema: un proyecto inline con `project`. */
function config(project: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-config-'))
  writeFileSync(
    join(dir, 'runner.yaml'),
    `sources:\n  projects:\n    p:\n      board: https://github.com/orgs/o/projects/1\n${project}`,
  )
  return dir
}

describe('project.yaml when', () => {
  it('without when, every card of the board is the project', () => {
    expect(loadRunnerConfig(config('')).projects[0]?.when).toEqual([])
  })

  it('takes rows over the card (item.*)', () => {
    const cfg = loadRunnerConfig(
      config('      when:\n        - { field: item.labels, op: notContains, value: blocked }\n'),
    )
    expect(cfg.projects[0]?.when).toEqual([
      { field: 'item.labels', op: 'notContains', value: 'blocked' },
    ])
  })

  it('rejects a field outside the card: the inbox could not evaluate it', () => {
    expect(() =>
      loadRunnerConfig(config('      when:\n        - { field: task.branch, op: exists }\n')),
    ).toThrow(/sólo mira la card/)
  })

  it('label is not a project key any more', () => {
    expect(() => loadRunnerConfig(config('      label: blocked\n'))).toThrow(/inválido/)
  })
})

describe('which runner.yaml', () => {
  it('a folder means its runner.yaml; a file is used as is', () => {
    const dir = config('')
    expect(runnerPathOf(dir)).toBe(join(dir, 'runner.yaml'))
    expect(runnerPathOf(join(dir, 'runner.yaml'))).toBe(join(dir, 'runner.yaml'))
  })

  it('a runner.local.yaml next to the real one: its relative paths are the same folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-local-'))
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true })
    const project = 'board: https://github.com/orgs/o/projects/1\n'
    writeFileSync(join(dir, 'projects', 'p', 'project.yaml'), project)
    writeFileSync(join(dir, 'projects', 'p', 'project.local.yaml'), `${project}branchPrefix: x/\n`)
    writeFileSync(
      join(dir, 'runner.yaml'),
      'sources:\n  projects:\n    p: ./projects/p/project.yaml\n',
    )
    writeFileSync(
      join(dir, 'runner.local.yaml'),
      'sources:\n  projects:\n    p: ./projects/p/project.local.yaml\n',
    )
    const local = loadRunnerConfig(join(dir, 'runner.local.yaml'))
    expect(local.runnerPath).toBe(join(dir, 'runner.local.yaml'))
    expect(local.dir).toBe(dir)
    expect(local.projects[0]?.branchPrefix).toBe('x/')
    expect(loadRunnerConfig(dir).projects[0]?.branchPrefix).toBeUndefined()
  })
})
