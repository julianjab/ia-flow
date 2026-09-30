/**
 * El bundle publicado les sirve a las actions de una config sus paquetes como módulos virtuales
 * (`bundle/modules.ts`), con las MISMAS instancias que usa el runner.
 */
import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { VIRTUAL_MODULES } from './modules.js'

describe('the bundle modules for a config', () => {
  it('serves the same zod the runner uses, not a copy', () => {
    expect(VIRTUAL_MODULES.zod?.z).toBe(z)
  })
})
