import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'

/**
 * Un sub-agente de Claude Code del repo (`.claude/agents/<nombre>.md`): frontmatter YAML
 * (`name`, `description`, `tools`, `model`) y el cuerpo, que es su system prompt. Es el formato
 * de Claude Code, no el del engine: la traducción a un `Agent` vive en `RunAgentAction`.
 */
export interface ClaudeAgent {
  name: string
  description: string
  /** Las tools de Claude Code que declara (`Read`, `Bash`, …). Ausente = todas. */
  tools?: string[]
  /** `sonnet` / `opus` / `haiku` / `inherit`, o un id de modelo. */
  model?: string
  /** El cuerpo del `.md`: su system prompt. */
  prompt: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** Los sub-agentes de `<dir>/.claude/agents/*.md`, por nombre. Sin la carpeta, ninguno. Un
 *  archivo sin frontmatter o sin `name` se saltea (Claude Code tampoco lo carga). */
export async function readClaudeAgents(dir: string): Promise<ClaudeAgent[]> {
  const folder = join(dir, '.claude', 'agents')
  let files: string[]
  try {
    files = (await readdir(folder)).filter((file) => file.endsWith('.md')).sort()
  } catch {
    return []
  }
  const agents: ClaudeAgent[] = []
  for (const file of files) {
    const agent = parseClaudeAgent(await readFile(join(folder, file), 'utf-8'))
    if (agent) agents.push(agent)
  }
  return agents
}

export function parseClaudeAgent(source: string): ClaudeAgent | undefined {
  const match = FRONTMATTER.exec(source)
  if (!match) return undefined
  let meta: unknown
  try {
    meta = parse(match[1] ?? '')
  } catch {
    return undefined
  }
  if (typeof meta !== 'object' || meta === null) return undefined
  const { name, description, tools, model } = meta as Record<string, unknown>
  if (typeof name !== 'string' || name.length === 0) return undefined
  const toolList = Array.isArray(tools)
    ? tools.map(String)
    : typeof tools === 'string'
      ? tools.split(',')
      : undefined
  return {
    name,
    description: typeof description === 'string' ? description : '',
    ...(toolList
      ? { tools: toolList.map((tool) => tool.trim()).filter((tool) => tool.length > 0) }
      : {}),
    ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
    prompt: (match[2] ?? '').trim(),
  }
}
