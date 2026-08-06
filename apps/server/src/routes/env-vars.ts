import { Hono } from 'hono'
import { getDbEnvVar, setDbEnvVar, deleteDbEnvVar } from '../db.js'

const SECRET_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN'] as const
const TEXT_KEYS = ['GITHUB_PROJECT_URL', 'LOG_LEVEL'] as const
const ALL_KEYS: readonly string[] = [...SECRET_KEYS, ...TEXT_KEYS]

export const ENV_VAR_DEFINITIONS: Record<string, { label: string; secret: boolean; description: string }> = {
  ANTHROPIC_API_KEY: {
    label: 'Anthropic API Key',
    secret: true,
    description: 'Requerida para el proveedor anthropic-api.',
  },
  CLAUDE_CODE_OAUTH_TOKEN: {
    label: 'Claude Code OAuth Token',
    secret: true,
    description: 'Alternativa OAuth al API key de Anthropic.',
  },
  GITHUB_TOKEN: {
    label: 'GitHub Token',
    secret: true,
    description: 'Para crear issues y PRs en GitHub Projects.',
  },
  GITHUB_PROJECT_URL: {
    label: 'GitHub Project URL',
    secret: false,
    description: 'URL del GitHub Project board que usa el daemon.',
  },
  LOG_LEVEL: {
    label: 'Log Level',
    secret: false,
    description: 'Nivel de logging del servidor (debug, info, warn, error).',
  },
}

export interface EnvVarState {
  isSet: boolean
  secret: boolean
  value: string | null
  label: string
  description: string
}

export function createEnvVarsRouter() {
  const router = new Hono()

  // GET /api/env-vars — current state (secrets masked)
  // DB value takes precedence; process env is the fallback shown when no DB value exists.
  router.get('/', (c) => {
    const vars: Record<string, EnvVarState> = {}
    for (const key of ALL_KEYS) {
      const def = ENV_VAR_DEFINITIONS[key]!
      const dbVal = getDbEnvVar(key)
      const effectiveVal = dbVal ?? Bun.env[key] ?? null
      vars[key] = {
        isSet: effectiveVal !== null,
        secret: def.secret,
        value: def.secret ? null : effectiveVal,
        label: def.label,
        description: def.description,
      }
    }
    return c.json({ vars })
  })

  // PUT /api/env-vars — update one or more env vars
  // Body: { [KEY]: string }  — empty string clears the var, non-empty sets it
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
