import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as lib from '../index.js'

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'shell-tools-index-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('package entrypoint', () => {
  it('exporta la API pública', () => {
    expect(lib.BashRunTool).toBeDefined()
    expect(lib.tokenize).toBeTypeOf('function')
    expect(lib.matchesPattern).toBeTypeOf('function')
    expect(lib.isDenied).toBeTypeOf('function')
    expect(lib.isAllowed).toBeTypeOf('function')
    expect(lib.DEFAULT_DENY_PATTERNS.length).toBeGreaterThan(0)
  })

  it('BashRunTool con DEFAULT_DENY_PATTERNS anda de punta a punta', async () => {
    const tool = new lib.BashRunTool({ baseDir, policy: { deny: lib.DEFAULT_DENY_PATTERNS } })

    const result = JSON.parse(await tool.handler({ command: 'echo ok' }))

    expect(result.stdout.trim()).toBe('ok')
  })
})
