import { Hono } from 'hono'
import { envRepo } from '../composition/container.js'
import { reloadManagers } from '../daemon.js'

export type EnvVarKind = 'password' | 'text' | 'select'
export type EnvVarGroup = 'anthropic' | 'github' | 'slack' | 'daemon' | 'providers' | 'server'

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

  // ── Daemon ─────────────────────────────────────────────────────────────────
  IA_FLOW_DAEMON_MODE: {
    label: 'Modo del daemon',
    description:
      'Cómo se entera el daemon de que hay trabajo: webhook (el provider empuja eventos) o polling (pull cada IA_FLOW_POLL_INTERVAL_MS). Default: webhook. Se puede sobreescribir por proyecto.',
    kind: 'select',
    group: 'daemon',
    secret: false,
    options: ['webhook', 'polling'],
  },
  IA_FLOW_WEBHOOK_SECRET: {
    label: 'Webhook Secret',
    description:
      'Secreto compartido con GitHub (firma x-hub-signature-256) y token de POST /api/webhooks/projects/:id. Obligatorio para el modo webhook: sin él los endpoints responden 503.',
    kind: 'password',
    group: 'daemon',
    secret: true,
  },
  IA_FLOW_WEBHOOK_FALLBACK_MS: {
    label: 'Respaldo del modo webhook (ms)',
    description:
      'Opcional y apagado por defecto (0): el modo webhook no hace pull. Poné un número > 0 sólo si querés un scan periódico de respaldo mientras el webhook no esté configurado.',
    kind: 'text',
    group: 'daemon',
    secret: false,
  },
  IA_FLOW_POLL_INTERVAL_MS: {
    label: 'Intervalo de polling (ms)',
    description: 'Interval del modo polling. Default 30000. No aplica al modo webhook.',
    kind: 'text',
    group: 'daemon',
    secret: false,
  },
  IA_FLOW_STARTUP_SCAN: {
    label: 'Scan al arrancar',
    description:
      'Al bootear, el daemon hace un scan de puesta al día (lo que se movió mientras estaba caído no generó webhooks que pudiéramos recibir). Poné 0 si te molesta que se re-despachen tareas en cada reinicio — en dev el server usa --watch y reinicia con cada archivo guardado. No afecta la limpieza de runs muertos ni el primer scan de un proyecto nuevo.',
    kind: 'select',
    group: 'daemon',
    secret: false,
    options: ['1', '0'],
  },
  IA_FLOW_CRASH_RECOVERY: {
    label: 'Limpiar runs muertos al arrancar',
    description:
      'Al bootear, limpia los flags "Working" que dejó un run muerto. Sin esto esas tareas quedan trabadas para siempre (todo scan las saltea). Poné 0 sólo si tus agentes sobreviven al reinicio del daemon (sesiones tmux/iterm) y limpiar el flag lanzaría un segundo agente sobre la misma tarea.',
    kind: 'select',
    group: 'daemon',
    secret: false,
    options: ['1', '0'],
  },

  // ── Providers remotos ──────────────────────────────────────────────────────
  IA_FLOW_REMOTE_HEALTH_INTERVAL_MS: {
    label: 'Sondeo de salud de providers remotos (ms)',
    description:
      'Cada cuánto se le pregunta a cada gateway registrado si sigue vivo. Un remoto sólo está disponible (registrado y elegible por un agente) mientras conteste. Default 30000. Aplica desde la ronda siguiente, sin reiniciar.',
    kind: 'text',
    group: 'providers',
    secret: false,
  },
  IA_FLOW_REMOTE_HEALTH_TIMEOUT_MS: {
    label: 'Timeout del sondeo de salud (ms)',
    description:
      'Cuánto se espera la respuesta de un gateway antes de darlo por caído. Default 3000.',
    kind: 'text',
    group: 'providers',
    secret: false,
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

  // ── OpenTelemetry (logs) ───────────────────────────────────────────────────
  // Las tres van al group `server` junto a LOG_LEVEL y NO a DAEMON_KEYS: un
  // cambio en runtime no reconstruye el sink OTel (el LoggerProvider se arma
  // una sola vez por proceso — al importar logger.ts, o en el segundo intento
  // de `initOtelSink()` justo después de `loadIntoProcess()`, nunca en un PUT),
  // y hacer creer al operador que sí lo hace es peor que no ofrecer la edición.
  // De ahí el "reiniciar el proceso" explícito en cada description.
  // Ver Q6 de docs/prd/otel-logs.md.
  OTEL_EXPORTER_OTLP_ENDPOINT: {
    label: 'OTLP Endpoint',
    description:
      'Collector OTLP/HTTP al que exportar los logs (ej. http://localhost:4318). Vacío = sink apagado. Toma efecto al reiniciar el proceso.',
    kind: 'text',
    group: 'server',
    secret: false,
  },
  OTEL_EXPORTER_OTLP_HEADERS: {
    label: 'OTLP Headers',
    description:
      'Headers extra para el collector, formato key1=value1,key2=value2 (ej. el api-key de Honeycomb/Datadog). Toma efecto al reiniciar el proceso.',
    kind: 'password',
    group: 'server',
    secret: true,
  },
  OTEL_SDK_DISABLED: {
    label: 'Apagar OTel',
    description:
      'Kill switch del sink OTLP: en true no se construye nada aunque haya endpoint. Toma efecto al reiniciar el proceso.',
    kind: 'select',
    group: 'server',
    secret: false,
    options: ['false', 'true'],
  },
} satisfies Record<string, EnvVarDefinition>

export const GROUP_LABELS: Record<EnvVarGroup, string> = {
  anthropic: 'Anthropic / Claude',
  github: 'GitHub',
  slack: 'Slack',
  daemon: 'Daemon (webhook / polling)',
  providers: 'Providers remotos',
  server: 'Servidor',
}

// Changing any of these only takes effect when the managers are rebuilt (mode
// and intervals are read in the manager constructor), so a PUT that touches
// them reloads the daemon instead of waiting for the next project mutation.
const DAEMON_KEYS = new Set([
  'IA_FLOW_DAEMON_MODE',
  'IA_FLOW_POLL_INTERVAL_MS',
  'IA_FLOW_WEBHOOK_FALLBACK_MS',
  'IA_FLOW_WEBHOOK_DEBOUNCE_MS',
  'IA_FLOW_STARTUP_SCAN',
  'IA_FLOW_CRASH_RECOVERY',
])

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
      const dbVal = envRepo.get(key)
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
    let daemonTouched = false
    for (const [key, value] of Object.entries(body)) {
      if (!ALL_KEYS.includes(key)) continue
      if (value === '') {
        envRepo.delete(key)
        delete (Bun.env as Record<string, string | undefined>)[key]
      } else {
        envRepo.set(key, value)
        ;(Bun.env as Record<string, string>)[key] = value
      }
      if (DAEMON_KEYS.has(key)) daemonTouched = true
    }
    // Swap the running managers so a mode/interval change applies now. The
    // secret is read per-request, so it needs no reload.
    if (daemonTouched) reloadManagers()
    return c.json({ ok: true, daemonReloaded: daemonTouched })
  })

  return router
}
