import { afterEach, describe, expect, test } from 'bun:test'
import {
  isProjectPaused,
  listPausedProjects,
  pauseProject,
  resumeProject,
} from './polling-pause.js'

afterEach(() => {
  for (const id of listPausedProjects()) resumeProject(id)
})

describe('polling-pause', () => {
  test('starts unpaused', () => {
    expect(isProjectPaused('p1')).toBe(false)
    expect(listPausedProjects()).toEqual([])
  })

  test('pause and resume flip the flag', () => {
    pauseProject('p1')
    expect(isProjectPaused('p1')).toBe(true)
    expect(listPausedProjects()).toEqual(['p1'])

    resumeProject('p1')
    expect(isProjectPaused('p1')).toBe(false)
    expect(listPausedProjects()).toEqual([])
  })

  test('pause is per-project', () => {
    pauseProject('p1')
    expect(isProjectPaused('p1')).toBe(true)
    expect(isProjectPaused('p2')).toBe(false)
  })

  test('pause is idempotent', () => {
    pauseProject('p1')
    pauseProject('p1')
    expect(listPausedProjects()).toEqual(['p1'])
  })

  test('resume of unpaused project is a no-op', () => {
    expect(() => resumeProject('nope')).not.toThrow()
    expect(isProjectPaused('nope')).toBe(false)
  })
})
