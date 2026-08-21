import { describe, expect, it } from 'bun:test'
import { buildOpenItermTabScript } from './provider.js'

describe('buildOpenItermTabScript', () => {
  it('does not call activate — must not steal OS focus when opening the tab', () => {
    const script = buildOpenItermTabScript('/repo', 'echo hi')
    expect(script).not.toContain('activate')
  })

  it('still creates a window when none exists and reuses the current one otherwise', () => {
    const script = buildOpenItermTabScript('/repo', 'echo hi')
    expect(script).toContain('create window with default profile')
    expect(script).toContain('set w to current window')
  })

  it('still creates the tab and writes the cd + command to it', () => {
    const script = buildOpenItermTabScript('/repo', 'echo hi')
    expect(script).toContain('create tab with default profile')
    expect(script).toContain('write text "cd \\"/repo\\""')
    expect(script).toContain('write text "echo hi"')
  })

  it('escapes double quotes in cwd and command', () => {
    const script = buildOpenItermTabScript('a"b', 'c"d')
    expect(script).toContain('write text "cd \\"a\\"b\\""')
    expect(script).toContain('write text "c\\"d"')
  })
})
