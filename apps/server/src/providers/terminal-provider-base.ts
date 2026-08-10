// Shared logic for terminal-based Claude providers (iTerm2 and tmux)
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { promisify } from 'node:util'
import { type McpServers, McpServersSchema } from '@ia-flow/shared'
import { z } from 'zod'
import { getToolDefinitions } from '../tools/index.js'
import type { StepInput } from './index.js'
import { loadProviderConfig } from './index.js'

// Per-agent providerConfig shape for terminal providers. Kept private to
// this file so shared/ stays agnostic. Strict → extra fields (e.g.
// anthropic-api specific ones) are rejected at runtime.
const TerminalAgentConfigSchema = z
  .object({
    model: z.string().optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
    mcpServers: McpServersSchema.optional(),
  })
  .strict()

function parseTerminalAgentConfig(
  raw: unknown,
): z.infer<typeof TerminalAgentConfigSchema> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = TerminalAgentConfigSchema.safeParse(raw)
  return r.success ? r.data : undefined
}

// Terminal-launched Claude sessions (iterm/tmux) don't get tools via the
// Anthropic API `tools:` param — they run the `claude` CLI which has its own
// tool-discovery layer. Our agent-declared tools live behind
// POST /api/tools/:name, so we tell Claude Code about them inline: name +
// description + JSON Schema of the input + how to call the HTTP endpoint.
// Kept at the END of the prompt so the human-authored body reads first.
function buildToolsAppendix(toolNames: string[] | undefined, taskId?: string): string {
  if (!toolNames?.length) return ''
  const allowed = new Set(toolNames)
  const defs = getToolDefinitions().filter((t) => allowed.has(t.name))
  if (!defs.length) return ''
  const daemonUrl = `http://localhost:${Bun.env.PORT ?? '3001'}`
  const blocks = defs.map((t) => {
    // Build a sample body from the schema: pre-fill task_id when the tool
    // takes one (so Claude doesn't have to guess), placeholder everything else.
    const schema = t.input_schema as {
      properties?: Record<string, { description?: string; type?: string }>
      required?: string[]
    }
    const props = schema.properties ?? {}
    const sample: Record<string, string> = {}
    for (const [key, def] of Object.entries(props)) {
      if (key === 'task_id' && taskId) {
        sample[key] = taskId
      } else if (def.description) {
        sample[key] = `<${def.description.split('.')[0]}>`
      } else {
        sample[key] = `<${key}>`
      }
    }
    return [
      `### ${t.name}`,
      t.description,
      '',
      '**Input schema:**',
      '```json',
      JSON.stringify(schema, null, 2),
      '```',
      '',
      '**Call:**',
      '```bash',
      `curl -sS -X POST ${daemonUrl}/api/tools/${t.name} \\`,
      `  -H 'content-type: application/json' \\`,
      `  -d '${JSON.stringify(sample)}'`,
      '```',
    ].join('\n')
  })
  return [
    '## Available tools (HTTP)',
    '',
    'These tools are exposed by the ia-flow daemon. Call them with `curl` (or an',
    'equivalent HTTP POST) — the daemon side-effects on your behalf and returns',
    'the result as JSON.',
    '',
    blocks.join('\n\n'),
  ].join('\n')
}

export const pexec = promisify(execFile)

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'task'
  )
}

// ─── Resolve a valid git base branch ─────────────────────────────────────

export async function resolveBaseBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 5_000,
    })
    const branch = stdout.trim()
    if (branch && branch !== 'HEAD') return branch
    for (const candidate of ['main', 'master', 'develop']) {
      try {
        await pexec('git', ['-C', repoPath, 'rev-parse', '--verify', candidate], { timeout: 3_000 })
        return candidate
      } catch {
        /* not found */
      }
    }
    return null
  } catch {
    return null
  }
}

// ─── Write prompt to temp file and build claude command ──────────────────

async function writeMcpConfigFile(servers: McpServers): Promise<string> {
  // Includes authorization tokens / headers — restrict to owner-only perms.
  const path = `/tmp/iaflow-mcp-${Date.now()}-${randomUUID().slice(0, 8)}.json`
  await Bun.write(path, JSON.stringify({ mcpServers: servers }, null, 2))
  await chmod(path, 0o600)
  return path
}

export async function buildClaudeCommand(
  input: StepInput,
  providerId: 'tmux-claude' | 'iterm-claude' = 'tmux-claude',
): Promise<{
  cmd: string
  promptFile: string
  env: Record<string, string>
  mcpConfigFile?: string
}> {
  const promptFile = `/tmp/iaflow-prompt-${Date.now()}.txt`
  const slug = slugify(input.taskTitle)
  const branchName = `feat/${slug}`

  const config = await loadProviderConfig()
  const termDefaults =
    providerId === 'iterm-claude' ? (config.itermClaude ?? {}) : (config.tmuxClaude ?? {})

  // Per-agent override — validated against this provider's private schema.
  const pc = parseTerminalAgentConfig(input.providerConfig)

  const model = pc?.model ?? termDefaults.model
  const dsp = pc?.dangerouslySkipPermissions ?? termDefaults.dangerouslySkipPermissions
  const resolvedMcpServers = pc?.mcpServers ?? termDefaults.mcpServers

  let claudeFlags = ''
  if (model) claudeFlags += ` --model ${model}`
  if (dsp) claudeFlags += ' --dangerously-skip-permissions'

  let mcpConfigFile: string | undefined
  if (resolvedMcpServers && Object.keys(resolvedMcpServers).length > 0) {
    mcpConfigFile = await writeMcpConfigFile(resolvedMcpServers)
    claudeFlags += ` --mcp-config "${mcpConfigFile}"`
  }

  let cmd = `claude${claudeFlags} < "${promptFile}"`
  let gitContext = ''

  if (input.step === 'implement' && input.cwd) {
    const workflow = input.workflow ?? 'branch'

    if (workflow === 'main') {
      const baseBranch = await resolveBaseBranch(input.cwd)
      gitContext = [
        '## Git context',
        `- Workflow: **main** — commit directly on \`${baseBranch ?? 'main'}\`, no branch needed`,
        `- Repo path: \`${input.cwd}\``,
      ].join('\n')
    } else if (workflow === 'worktree') {
      const baseBranch = await resolveBaseBranch(input.cwd)
      if (baseBranch) {
        cmd = `cd "${input.cwd}" && claude --worktree ${branchName}${claudeFlags} < "${promptFile}"`
        gitContext = [
          '## Git context',
          `- Workflow: **worktree** — Claude created a git worktree for this session (flag \`--worktree ${branchName}\`)`,
          `- Branch: \`${branchName}\` (based on \`${baseBranch}\`)`,
          `- Main repo: \`${input.cwd}\``,
          `- When done: push \`${branchName}\` and open a PR against \`${baseBranch}\``,
        ].join('\n')
      }
    } else {
      // branch — checkout in-place
      const baseBranch = await resolveBaseBranch(input.cwd)
      if (baseBranch) {
        cmd = `git checkout -b ${branchName} 2>/dev/null || git checkout ${branchName} && claude < "${promptFile}"`
        gitContext = [
          '## Git context',
          `- Workflow: **branch** — a new branch has been checked out in-place`,
          `- Branch: \`${branchName}\` (based on \`${baseBranch}\`)`,
          `- Repo path: \`${input.cwd}\``,
          `- When done: push \`${branchName}\` and open a PR against \`${baseBranch}\``,
        ].join('\n')
      } else {
        cmd = `claude < "${promptFile}"`
      }
    }
  }

  const toolsAppendix = buildToolsAppendix(input.tools, input.taskId)
  const parts = [gitContext, input.prompt, toolsAppendix].filter((p) => p?.length)
  const fullPrompt = parts.join('\n\n')
  await Bun.write(promptFile, fullPrompt)

  return { cmd, promptFile, env: termDefaults.env ?? {}, mcpConfigFile }
}
