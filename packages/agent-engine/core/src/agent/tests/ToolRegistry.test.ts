import { describe, expect, it } from 'vitest'
import type { Tool } from '../AgentDefinition.js'
import { type ToolConstructor, ToolRegistry } from '../ToolRegistry.js'

interface FixtureDeps {
  prefix: string
}

// --- dominio "alpha" ---------------------------------------------------------------------
class AlphaRegistry extends ToolRegistry<[FixtureDeps]> {
  protected static registeredTools: ToolConstructor<[FixtureDeps]>[] = []
}

class AlphaOneTool implements Tool<{ x: number }> {
  readonly name = 'alpha_one'
  readonly description = 'alpha one'
  readonly inputSchema = { type: 'object' }
  constructor(private readonly deps: FixtureDeps) {}
  handler(input: { x: number }) {
    return `${this.deps.prefix}:${input.x}`
  }
}
AlphaRegistry.register(AlphaOneTool)

class AlphaTwoTool implements Tool {
  readonly name = 'alpha_two'
  readonly description = 'alpha two'
  readonly inputSchema = { type: 'object' }
  handler() {
    return 'two'
  }
}
AlphaRegistry.register(AlphaTwoTool)

// --- dominio "beta" ------------------------------------------------------------------------
class BetaRegistry extends ToolRegistry<[FixtureDeps]> {
  protected static registeredTools: ToolConstructor<[FixtureDeps]>[] = []
}

class BetaOnlyTool implements Tool {
  readonly name = 'beta_only'
  readonly description = 'beta only'
  readonly inputSchema = { type: 'object' }
  handler() {
    return 'beta'
  }
}
BetaRegistry.register(BetaOnlyTool)

describe('ToolRegistry', () => {
  it('names()/all() reflejan las tools auto-registradas de ESE dominio', () => {
    const alpha = new AlphaRegistry({ prefix: 'a' })
    expect(alpha.names()).toEqual(['alpha_one', 'alpha_two'])
    expect(alpha.all().map((t) => t.name)).toEqual(['alpha_one', 'alpha_two'])
  })

  it('get(name) resuelve una tool ya construida con los args del constructor', () => {
    const alpha = new AlphaRegistry({ prefix: 'x' })
    const tool = alpha.get('alpha_one') as Tool<{ x: number }>
    expect(tool.handler({ x: 7 })).toBe('x:7')
  })

  it('get(name) tira con mensaje útil para un nombre desconocido', () => {
    const alpha = new AlphaRegistry({ prefix: 'a' })
    expect(() => alpha.get('nope')).toThrow('nope')
    expect(() => alpha.get('nope')).toThrow('alpha_one')
  })

  it('resolve(names) mapea en orden, tira en el primer nombre desconocido', () => {
    const alpha = new AlphaRegistry({ prefix: 'a' })
    expect(alpha.resolve(['alpha_two', 'alpha_one']).map((t) => t.name)).toEqual([
      'alpha_two',
      'alpha_one',
    ])
    expect(() => alpha.resolve(['alpha_one', 'nope'])).toThrow('nope')
  })

  it('dos subclases que redeclaran su propio "registeredTools" NUNCA comparten lista', () => {
    const beta = new BetaRegistry({ prefix: 'b' })
    expect(beta.names()).toEqual(['beta_only'])
    // si compartieran el static de la base, beta también vería las tools de alpha acá.
    expect(beta.names()).not.toContain('alpha_one')

    const alpha = new AlphaRegistry({ prefix: 'a' })
    expect(alpha.names()).not.toContain('beta_only')
  })

  it('cada instancia del registry construye sus PROPIAS instancias de tool (no comparte estado)', () => {
    const a1 = new AlphaRegistry({ prefix: 'uno' })
    const a2 = new AlphaRegistry({ prefix: 'dos' })
    expect((a1.get('alpha_one') as Tool<{ x: number }>).handler({ x: 1 })).toBe('uno:1')
    expect((a2.get('alpha_one') as Tool<{ x: number }>).handler({ x: 1 })).toBe('dos:1')
  })
})
