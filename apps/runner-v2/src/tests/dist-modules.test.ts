/**
 * El bundle publicado les sirve a las actions de `.config/` sus paquetes como módulos virtuales
 * (`bundle/modules.ts`). Un import que no esté en la lista funciona desde el árbol de trabajo
 * (`node_modules`) y rompe recién en el deploy: acá se ve antes.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { VIRTUAL_MODULES } from '../bundle/modules.js'
import { CONFIG_DIR } from './helpers.js'

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

/** Los paquetes que importa un módulo (no los relativos ni los built-in de Bun/Node). */
function packageImports(source: string): string[] {
  const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] as string,
  )
  return specifiers.filter(
    (specifier) =>
      !specifier.startsWith('.') && !specifier.startsWith('bun:') && !specifier.startsWith('node:'),
  )
}

describe('the bundle modules for the .config actions', () => {
  it('every package a .config action imports is served by the bundle', () => {
    const missing = tsFiles(CONFIG_DIR).flatMap((file) =>
      packageImports(readFileSync(file, 'utf8'))
        .filter((specifier) => !(specifier in VIRTUAL_MODULES))
        .map((specifier) => `${file}: ${specifier}`),
    )
    expect(missing).toEqual([])
  })

  it('serves the same zod the runner uses, not a copy', () => {
    expect(VIRTUAL_MODULES.zod?.z).toBe(z)
  })
})
