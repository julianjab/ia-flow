import { Hono } from 'hono'
import { deleteDbEnvVar, getDbEnvVar, setDbEnvVar } from '../db.js'

export type EnvVarKind = 'password' | 'text' | 'select'
export type EnvVarGroup = 'anthropic' | 'github' | 'slack' | 'server'

export interface EnvVarDefinition {
  label: string
  description: string
  kind: EnvVarKind
  group: EnvVarGroup
  secret: boolean
  options?: string[]
}

// Order of insertion here drives order in the UI. Group entries by feature.
export const ENV_VAR_DEFINITIONS = {
  // ── Anthropic / Claude ─────────────────────────────────────────────────────
  ANTHROPIC_API_KEY: {
    label: 'Anthropic API Key',
    description: 'Requerida para el proveedor anthropic-api.',
    kind: 'password',
    group: 'anthropic',
    secret: true,
  },
  CLAUDE_CODE_OAUTH_TOKEN: {
    label: 'Claude Code OAuth Token',
    description: 'Alternativa OAuth al API key de Anthropic.',
    kind: 'password',
    group: 'anthropic',
    secret: true,
  },

  // ── GitHub ─────────────────────────────────────────────────────────────────
  GITHUB_TOKEN: {
    label: 'GitHub Token',
    description: 'Para crear issues y PRs en GitHub Projects.',
    kind: 'password',
    group: 'github',
    secret: true,
  },
  // ── Slack ──────────────────────────────────────────────────────────────────
  SLACK_BOT_TOKEN: {
    label: 'Slack Bot Token',
    description:
      'Token xoxb-... con scopes channels:history, groups:history, im:history, mpim:history.',
    kind: 'password',
    group: 'slack',
    secret: true,
  },

  // ── Server ─────────────────────────────────────────────────────────────────
  LOG_LEVEL: {
    label: 'Log Level',
    description: 'Nivel de logging del servidor.',
    kind: 'select',
    group: 'server',
    secret: false,
    options: ['debug', 'info', 'warn', 'error'],
  },
} satisfies Record<string, EnvVarDefinition>

export const GROUP_LABELS: Record<EnvVarGroup, string> = {
  anthropic: 'Anthropic / Claude',
  github: 'GitHub',
  slack: 'Slack',
  server: 'Servidor',
}

const ALL_KEYS = Object.keys(ENV_VAR_DEFINITIONS)

export interface EnvVarState {
  isSet: boolean
  secret: boolean
  value: string | null
  label: string
  description: string
  kind: EnvVarKind
  group: EnvVarGroup
  groupLabel: string
  options?: string[]
}

export function createEnvVarsRouter() {
  const router = new Hono()

  // GET /api/env-vars — current state (secrets masked).
  // DB value takes precedence; process env is the fallback shown when no DB value exists.
  router.get('/', (c) => {
    const vars: Record<string, EnvVarState> = {}
    for (const key of ALL_KEYS) {
      const def = ENV_VAR_DEFINITIONS[key as keyof typeof ENV_VAR_DEFINITIONS]
      const dbVal = getDbEnvVar(key)
      const effectiveVal = dbVal ?? Bun.env[key] ?? null
      vars[key] = {
        isSet: effectiveVal !== null,
        secret: def.secret,
        value: def.secret ? null : effectiveVal,
        label: def.label,
        description: def.description,
        kind: def.kind,
        group: def.group,
        groupLabel: GROUP_LABELS[def.group],
        options: 'options' in def ? def.options : undefined,
      }
    }
    return c.json({ vars })
  })

  // PUT /api/env-vars — update one or more env vars.
  // Body: { [KEY]: string }  — empty string clears the var, non-empty sets it.
  router.put('/', async (c) => {
    const body = await c.req.json<Record<string, string>>()
    for (const [key, value] of Object.entries(body)) {
      if (!ALL_KEYS.includes(key)) continue
      if (value === '') {
        deleteDbEnvVar(key)
        delete (Bun.env as Record<string, string | undefined>)[key]
      } else {
        setDbEnvVar(key, value)
        ;(Bun.env as Record<string, string>)[key] = value
      }
    }
    return c.json({ ok: true })
  })

  return router
}
