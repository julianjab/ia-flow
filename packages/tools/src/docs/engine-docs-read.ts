import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'

let docsRoot: string | null = null

/** Raíz del repo desde donde escanear los `CLAUDE.md`. Wireado sólo en el
 *  flavor `full` que corre desde el working tree — un deploy headless sin el
 *  repo fuente deja esto sin setear y la tool degrada con un aviso, no
 *  tira. */
export function setDocsRoot(root: string | null): void {
  docsRoot = root
}

const MAX_MATCHES = 5
const CONTEXT_CHARS = 500

function findClaudeMdFiles(root: string): string[] {
  const glob = new Bun.Glob('**/CLAUDE.md')
  const out: string[] = []
  for (const rel of glob.scanSync({ cwd: root, onlyFiles: true })) {
    if (rel.includes('node_modules/')) continue
    out.push(join(root, rel))
  }
  return out
}

registerTool({
  name: 'search_engine_docs',
  description:
    'Busca un texto en la documentación del engine (los CLAUDE.md del repo ia-flow) — usala para explicar cómo funciona el engine por dentro.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Texto a buscar (case-insensitive).' },
    },
    required: ['query'],
  },
  async execute(input: unknown, _ctx?: ToolContext): Promise<string> {
    if (!docsRoot || !existsSync(docsRoot)) {
      return 'No hay documentación disponible en este runtime.'
    }
    const { query } = input as { query: string }
    const q = query.trim().toLowerCase()
    if (!q) throw new Error("'query' no puede estar vacío.")

    const matches: Array<{ file: string; excerpt: string }> = []
    for (const file of findClaudeMdFiles(docsRoot)) {
      if (matches.length >= MAX_MATCHES) break
      const content = readFileSync(file, 'utf-8')
      const idx = content.toLowerCase().indexOf(q)
      if (idx === -1) continue
      const start = Math.max(0, idx - CONTEXT_CHARS / 2)
      const end = Math.min(content.length, idx + CONTEXT_CHARS / 2)
      matches.push({
        file: file.startsWith(docsRoot) ? file.slice(docsRoot.length + 1) : file,
        excerpt: content.slice(start, end),
      })
    }
    if (!matches.length) return `No encontré "${query}" en la documentación del engine.`
    return JSON.stringify(matches, null, 2)
  },
})
