import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServerRef } from '@ia-flow/agent-engine'
import { MCP_SERVER_NAME, mcpToolName } from '@ia-flow/provider-shared'
import type { RunEndpoints } from './RunServer.js'

/** Los hooks de Claude Code que se reenvían al runner: traza (`Pre`/`PostToolUse`), inbox
 *  (`PostToolUse`, `Stop`) y cierre (`Stop`). */
const HOOKS = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'UserPromptSubmit',
] as const
const TOOL_HOOKS = new Set<string>(['PreToolUse', 'PostToolUse'])

export interface SessionSpec {
  endpoints: RunEndpoints
  /** Los system prompts del agente, ya resueltos. */
  systemPrompts: string[]
  /** Las tools terminales, para la nota de sesión desatendida. */
  exits: string[]
  /** Los MCP externos del agente (`github-mcp`, …). */
  mcpServers: McpServerRef[]
  /** Van al `env` del `--settings`. */
  env: Record<string, string>
  model?: string
  /** `--disallowedTools`; vacío = sin el flag. */
  disallowedTools: string[]
  args: string[]
  /** La sesión del CLI: una nueva con ese id, o retomar la que tiene ese id. */
  session: { id: string; resume: boolean }
}

export interface SessionFiles {
  /** Los flags comunes a los dos modos (sin el prompt ni `-p`). */
  argv: string[]
  dir: string
  cleanup(): Promise<void>
}

/**
 * Lo que la sesión lee de disco, en una carpeta propia (0700) con archivos 0600 — el `--settings`
 * y el `--mcp-config` llevan tokens:
 *
 * - `--append-system-prompt-file`: los system prompts del agente y, última, la nota de sesión
 *   desatendida (es del engine: describe cómo corre, gana sobre lo que diga el agente).
 * - `--settings`: `env` (la credencial y lo que pida el agente, sin pasar por el shell) y los
 *   hooks, que le pegan al servidor local con `curl` (un `|| true`: un hook que falla nunca corta
 *   la sesión).
 * - `--mcp-config`: el MCP de la corrida (`ia-flow`) y los externos del agente, con su token
 *   como header.
 *
 * Todo el CLI queda habilitado (`--dangerously-skip-permissions`): corre sin nadie que apruebe.
 */
export async function writeSessionFiles(spec: SessionSpec): Promise<SessionFiles> {
  const dir = await mkdtemp(join(tmpdir(), 'ia-flow-claude-'))
  const file = async (name: string, content: string) => {
    const path = join(dir, name)
    await writeFile(path, content, { mode: 0o600 })
    return path
  }
  const sysprompt = await file('system-prompt.md', systemPrompt(spec))
  const settings = await file('settings.json', JSON.stringify(settingsOf(spec), null, 2))
  const mcp = await file('mcp.json', JSON.stringify(await mcpConfig(spec), null, 2))
  const argv = [
    spec.session.resume ? '--resume' : '--session-id',
    spec.session.id,
    '--settings',
    settings,
    '--mcp-config',
    mcp,
    '--append-system-prompt-file',
    sysprompt,
    '--dangerously-skip-permissions',
    ...(spec.model ? ['--model', spec.model] : []),
    // Un solo argumento separado por comas: el flag es variádico y se comería lo que venga atrás.
    ...(spec.disallowedTools.length > 0
      ? ['--disallowedTools', spec.disallowedTools.join(',')]
      : []),
    ...spec.args,
  ]
  return { argv, dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export function unattendedNote(exits: string[]): string {
  return [
    '## Sesión desatendida',
    '',
    'Esta sesión corre sin supervisión humana: nadie va a leer una pregunta ni responderla. No',
    'preguntes ni esperes confirmación — tomá la mejor decisión con el contexto que tenés y seguí.',
    'Antes de terminar, dejá publicado todo lo que el flujo de trabajo requiera.',
    '',
    `Tu turno termina SÓLO llamando a una de estas tools del servidor \`${MCP_SERVER_NAME}\`: ${exits.map((exit) => `\`${exit}\``).join(', ')}, o \`${mcpToolName('fail_turn')}\` si no podés completar la tarea. Terminar sin llamarlas no cuenta.`,
  ].join('\n')
}

function systemPrompt(spec: SessionSpec): string {
  const agent = spec.systemPrompts.filter((text) => text.trim()).join('\n\n')
  const note = unattendedNote(spec.exits.map(mcpToolName))
  return agent ? `${agent}\n\n${note}` : note
}

function settingsOf(spec: SessionSpec): Record<string, unknown> {
  const hook = (event: string) => ({
    type: 'command',
    command: `curl -sS --max-time 15 -X POST -H 'content-type: application/json' --data-binary @- '${spec.endpoints.hooks}/${event}' || true`,
  })
  const hooks = Object.fromEntries(
    HOOKS.map((event) => [
      event,
      [TOOL_HOOKS.has(event) ? { matcher: '.*', hooks: [hook(event)] } : { hooks: [hook(event)] }],
    ]),
  )
  return { ...(Object.keys(spec.env).length > 0 ? { env: spec.env } : {}), hooks }
}

/** El MCP de la corrida y los externos que tienen URL (el CLI no recibe uno sin transporte
 *  remoto desde acá). Un token que es función se resuelve ahora. */
async function mcpConfig(spec: SessionSpec): Promise<Record<string, unknown>> {
  const servers: Record<string, unknown> = {
    [MCP_SERVER_NAME]: { type: 'http', url: spec.endpoints.mcp },
  }
  for (const { id, config } of spec.mcpServers) {
    if (typeof config.url !== 'string' || id === MCP_SERVER_NAME) continue
    const raw = config.authorizationToken
    const token = typeof raw === 'function' ? await (raw as () => unknown)() : raw
    servers[id] = {
      type: config.type === 'sse' ? 'sse' : 'http',
      url: config.url,
      ...(typeof token === 'string' && token
        ? { headers: { Authorization: `Bearer ${token}` } }
        : {}),
    }
  }
  return { mcpServers: servers }
}
