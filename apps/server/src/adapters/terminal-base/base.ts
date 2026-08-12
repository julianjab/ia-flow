// Shared logic for terminal-based Claude providers (iTerm2 and tmux)
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { promisify } from 'node:util'
import { type McpServers, McpServersSchema } from '@ia-flow/shared'
import { z } from 'zod'
import { loadProviderConfig } from '../../application/provider-config.js'
import type { ProviderInput } from '../../domain/ports/IAgentProvider.js'
import { buildToolInstructions } from '../../tools/index.js'

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
// POST /api/tools/:name; the rendering (name + description + curl block)
// lives in tools/index.ts `buildToolInstructions` so both this appendix and
// any future entry point share one canonical shape.

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

// Claude CLI's `.mcpServers` accepts http entries with `headers` but not the
// ia-flow-specific `authorizationToken`. Translate so a single seed shape works
// for both the Anthropic API (authorization_token) and the CLI (Bearer header).
function toCliMcpServers(servers: McpServers): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, srv] of Object.entries(servers)) {
    if (!('url' in srv)) {
      out[name] = srv
      continue
    }
    const { authorizationToken, headers, ...rest } = srv
    const mergedHeaders = { ...(headers ?? {}) }
    if (authorizationToken && !mergedHeaders.Authorization) {
      mergedHeaders.Authorization = `Bearer ${authorizationToken}`
    }
    out[name] = Object.keys(mergedHeaders).length ? { ...rest, headers: mergedHeaders } : rest
  }
  return out
}

async function writeMcpConfigFile(servers: McpServers): Promise<string> {
  // Includes authorization tokens / headers — restrict to owner-only perms.
  const path = `/tmp/iaflow-mcp-${Date.now()}-${randomUUID().slice(0, 8)}.json`
  await Bun.write(path, JSON.stringify({ mcpServers: toCliMcpServers(servers) }, null, 2))
  await chmod(path, 0o600)
  return path
}

export async function buildClaudeCommand(
  input: ProviderInput,
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

  const daemonUrl = `http://localhost:${Bun.env.PORT ?? '3001'}`
  const toolsAppendix = buildToolInstructions(
    input.tools,
    { id: providerId, kind: 'async' },
    daemonUrl,
    input.taskId,
    { disabledTools: input.disabledTools },
  )
  const parts = [gitContext, input.prompt, toolsAppendix].filter((p) => p?.length)
  const fullPrompt = parts.join('\n\n')
  await Bun.write(promptFile, fullPrompt)

  const env: Record<string, string> = { ...(termDefaults.env ?? {}) }
  if (Bun.env.CLAUDE_CODE_OAUTH_TOKEN && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  }

  // Login shells (tmux `$SHELL -lc`, new iTerm tabs) re-source ~/.zshrc /
  // ~/.zprofile, which typically re-exports ANTHROPIC_API_KEY. Unset it
  // right before `claude` runs so the OAuth token wins with no conflict.
  cmd = `unset ANTHROPIC_API_KEY; ${cmd}`

  return { cmd, promptFile, env, mcpConfigFile }
}
