import { Hono } from 'hono'
import { relevantConfigVars } from '../composition/config-vars.js'
import { envRepo, githubCredentials } from '../composition/container.js'
import { reloadManagers } from '../daemon.js'

export type EnvVarKind = 'password' | 'text' | 'select'
export type EnvVarGroup =
  | 'anthropic'
  | 'github'
  | 'slack'
  | 'figma'
  | 'daemon'
  | 'providers'
  | 'server'

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

  // ── Figma ─────────────────────────────────────────────────────────────────
  FIGMA_MCP_TOKEN: {
    label: 'Figma MCP Token (estático)',
    description:
      'Sólo para un deploy que no puede correr un browser. El camino normal es `bun run auth:figma`, que deja una sesión OAuth que el daemon renueva sola; este token se pega a mano y no se renueva. Se usa únicamente si no hay sesión guardada. En los dos casos el MCP lo recibe como ${FIGMA_TOKEN}.',
    kind: 'password',
    group: 'figma',
    secret: true,
  },

  // ── GitHub ─────────────────────────────────────────────────────────────────
  IA_FLOW_GITHUB_AUTH_MODE: {
    label: 'Modo de auth de GitHub',
    description:
      'Con qué identidad habla ia-flow con GitHub. auto (default) prueba GitHub App → GITHUB_TOKEN → gh CLI y usa la primera configurada (gh va último: es estado de la máquina, no config de ia-flow). static: el GITHUB_TOKEN de abajo. gh-cli: delega en el `gh` autenticado acá (tu usuario). github-app: identidad de bot con token que rota solo — el modo recomendado para un daemon.',
    kind: 'select',
    group: 'github',
    secret: false,
    options: ['auto', 'static', 'gh-cli', 'github-app'],
  },
  GITHUB_TOKEN: {
    label: 'GitHub Token',
    description: 'PAT para el modo static. Para crear issues y PRs en GitHub Projects.',
    kind: 'password',
    group: 'github',
    secret: true,
  },
  IA_FLOW_GITHUB_APP_ID: {
    label: 'GitHub App ID',
    description: 'Modo github-app: el App ID que figura en la página de la app.',
    kind: 'text',
    group: 'github',
    secret: false,
  },
  IA_FLOW_GITHUB_APP_PRIVATE_KEY: {
    label: 'GitHub App Private Key',
    description:
      'Modo github-app: contenido del .pem que descargaste de la app (PEM crudo o base64). Alternativa: IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH con la ruta al archivo.',
    kind: 'password',
    group: 'github',
    secret: true,
  },
  IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH: {
    label: 'GitHub App Private Key (path)',
    description:
      'Alternativa a pegar el PEM: ruta al archivo .pem en este disco. La variable inline gana si están las dos.',
    kind: 'text',
    group: 'github',
    secret: false,
  },
  IA_FLOW_GITHUB_APP_INSTALLATION_ID: {
    label: 'GitHub App Installation ID',
    description:
      'Opcional. Sólo hace falta si la app está instalada en más de una cuenta — con una sola, ia-flow la descubre.',
    kind: 'text',
    group: 'github',
    secret: false,
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

  IA_FLOW_FATAL_POLICY: {
    label: 'Qué hacer ante un fallo no capturado',
    description:
      'survive (default): un `uncaughtException` o un `unhandledRejection` NO mata al daemon — se cancelan los runs en vuelo (su issue queda comentado por la salida de error) y el proceso sigue atendiendo webhooks. exit: se cancelan igual y después sale con código 1, para deploys con un supervisor que lo levanta limpio. Las sesiones async (tmux/iterm, gateways remotos) nunca se cancelan: sobreviven al proceso. Toma efecto en el próximo fallo, sin reiniciar.',
    kind: 'select',
    group: 'server',
    secret: false,
    options: ['survive', 'exit'],
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
  figma: 'Figma',
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

/**
 * Las claves que este proceso ofrece: el catálogo intersectado con lo que los
 * dueños declaran relevante (`composition/config-vars.ts`).
 *
 * Se calcula **por request** y no una vez al importar: cambiar el modo de auth
 * de GitHub desde esta misma pantalla cambia qué campos tienen sentido, y el
 * operador tiene que ver el efecto al recargar, no al reiniciar el daemon.
 *
 * Un nombre relevante que NO esté en el catálogo se ignora en silencio a
 * propósito — sin label ni descripción no hay nada que renderizar. El test de
 * `test/env-vars-coverage.test.ts` es el que impide que eso pase inadvertido.
 */
function visibleKeys(): string[] {
  const relevant = relevantConfigVars()
  return ALL_KEYS.filter((key) => relevant.has(key))
}

/**
 * De dónde sale el valor que este proceso está usando. `null` = no hay valor.
 *
 * `env` es lo que el proceso trajo del ambiente (shell, `.env`, el compose o
 * el `runner.yaml` de un deploy); `db` es lo que alguien guardó desde esta
 * pantalla. **El entorno gana** — ver `SqliteEnvVarRepository`.
 */
export type EnvVarSource = 'db' | 'env' | null

export interface EnvVarState {
  isSet: boolean
  secret: boolean
  value: string | null
  /** Ver `EnvVarSource`. La precedencia es env > db. */
  source: EnvVarSource
  /**
   * Hay valor guardado que NO se está aplicando, porque el entorno define esa
   * variable con otro valor. Es el único caso en que "guardé y no pasó nada"
   * tiene una explicación, y esta bandera es lo que permite darla en vez de
   * que el operador la descubra a los golpes.
   */
  savedButUnused: boolean
  label: string
  description: string
  kind: EnvVarKind
  group: EnvVarGroup
  groupLabel: string
  options?: string[]
}

/**
 * Resuelve valor + procedencia de UNA variable. Puro a propósito: es la única
 * regla de esta ruta que vale la pena testear, y depende de tres datos que el
 * llamador ya tiene.
 *
 * `envValue` es `Bun.env[key]` DESPUÉS de `loadIntoProcess`. Como con esta
 * precedencia el repositorio nunca pisa un valor del ambiente, ese dato solo
 * no distingue "lo trajo el ambiente" de "lo rellenamos desde la DB": eso lo
 * aporta `overriddenByEnv`, que el repositorio sí sabe.
 */
export function resolveEnvVarValue(
  dbValue: string | null,
  envValue: string | undefined,
  overriddenByEnv: boolean,
): { value: string | null; source: EnvVarSource; savedButUnused: boolean } {
  // El ambiente definió esta variable con otro valor: gana, y lo guardado
  // queda esperando a que salga del entorno.
  if (overriddenByEnv) return { value: envValue ?? null, source: 'env', savedButUnused: true }
  // Sin override, el valor en uso y el guardado coinciden (o no hay fila y el
  // valor viene del ambiente tal cual). `dbValue` decide cuál nombrar.
  const value = envValue ?? dbValue ?? null
  if (value === null) return { value: null, source: null, savedButUnused: false }
  return { value, source: dbValue !== null ? 'db' : 'env', savedButUnused: false }
}

export function createEnvVarsRouter() {
  const router = new Hono()

  // GET /api/env-vars — current state (secrets masked).
  // El entorno del proceso gana; lo guardado se usa cuando el entorno no
  // define la variable. `source`/`savedButUnused` dicen cuál de las dos está
  // en uso, para que la pantalla no tenga que adivinarlo (ver
  // resolveEnvVarValue).
  router.get('/', (c) => {
    const vars: Record<string, EnvVarState> = {}
    // Una sola lectura para todas las claves: no varía dentro del request.
    const overridden = new Set(envRepo.keysOverriddenByEnv())
    for (const key of visibleKeys()) {
      const def = ENV_VAR_DEFINITIONS[key as keyof typeof ENV_VAR_DEFINITIONS]
      const resolved = resolveEnvVarValue(envRepo.get(key), Bun.env[key], overridden.has(key))
      vars[key] = {
        isSet: resolved.value !== null,
        secret: def.secret,
        value: def.secret ? null : resolved.value,
        source: resolved.source,
        savedButUnused: resolved.savedButUnused,
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
    let githubTouched = false
    const invalid: string[] = []
    for (const [key, value] of Object.entries(body)) {
      // `ALL_KEYS` y NO `visibleKeys()`: escribir se valida contra el catálogo
      // entero. Un PUT puede cambiar el modo de auth Y el valor que ese modo
      // vuelve relevante en la misma llamada — filtrar por la visibilidad
      // ANTERIOR descartaría el segundo campo y dejaría al operador con el
      // modo cambiado y sin credencial.
      if (!ALL_KEYS.includes(key)) continue
      const def = ENV_VAR_DEFINITIONS[key as keyof typeof ENV_VAR_DEFINITIONS]
      // Un `select` sólo acepta sus propias opciones. Sin esto, un típo entra a
      // la DB y el error aparece lejos, cuando quien lee el valor lo parsea.
      if (value !== '' && 'options' in def && !def.options.includes(value)) {
        invalid.push(key)
        continue
      }
      // `Bun.env` lo mueve el repositorio, no esta ruta: es el único que sabe
      // qué traía el ambiente antes de que la DB lo tapara, y por lo tanto el
      // único que puede DEVOLVERLE el valor al borrar la fila. Cuando el
      // borrado se hacía acá con un `delete Bun.env[key]`, limpiar la variable
      // desde la pantalla destruía el valor del shell o del compose: el
      // proceso quedaba sin ninguno hasta reiniciar.
      if (value === '') envRepo.delete(key)
      else envRepo.set(key, value)
      if (DAEMON_KEYS.has(key)) daemonTouched = true
      // Por grupo y no por lista de keys: una variable de auth nueva queda
      // cubierta sola.
      if (ENV_VAR_DEFINITIONS[key as keyof typeof ENV_VAR_DEFINITIONS].group === 'github')
        githubTouched = true
    }
    // Swap the running managers so a mode/interval change applies now. The
    // secret is read per-request, so it needs no reload.
    if (daemonTouched) reloadManagers()
    // El token SÍ se lee por request, pero la *estrategia* que lo produce se
    // resuelve una vez y queda cacheada: sin este reset, un arranque sin
    // credenciales deja un provider sin token para siempre y pegar el PAT acá
    // no cambia nada hasta reiniciar.
    if (githubTouched) githubCredentials.reset()
    if (invalid.length)
      return c.json({ error: `valor inválido para: ${invalid.join(', ')}`, invalid }, 400)
    return c.json({ ok: true, daemonReloaded: daemonTouched, githubAuthReset: githubTouched })
  })

  return router
}
