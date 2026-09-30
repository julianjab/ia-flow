import { describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_RUNNER_HOME,
  defaultDatabasePath,
  defaultWorkspaceRoot,
  runnerHome,
} from './runnerHome.js'

describe('runnerHome', () => {
  it('is IA_FLOW_HOME, with ~ expanded, or ~/.local/state/ia-flow/runner', () => {
    expect(runnerHome({ IA_FLOW_HOME: '/state' })).toBe('/state')
    expect(runnerHome({ IA_FLOW_HOME: '~/x' })).toBe(join(homedir(), 'x'))
    expect(runnerHome({ IA_FLOW_HOME: '  ' })).toBe(DEFAULT_RUNNER_HOME)
    expect(runnerHome({})).toBe(join(homedir(), '.local', 'state', 'ia-flow', 'runner'))
  })

  it('holds the database and the workspaces', () => {
    expect(defaultDatabasePath('/state')).toBe('/state/runner.sqlite')
    expect(defaultWorkspaceRoot('/state')).toBe('/state/workspaces')
  })
})
