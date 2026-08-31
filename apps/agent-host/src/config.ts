// La config declarativa de este agent-host: un `agent-host.yaml`, hermano del
// `runner.yaml` del flavor `runner` (`apps/server/src/runner/config.ts`).
//
// ── Por qué existe ────────────────────────────────────────────────────────
//
// Hasta acá el arranque en frío eran env vars sueltas y el único archivo era
// `agent-host.json`, que NO es config: es estado que escribe la pantalla. Los
// dos alcanzan mientras el agent-host vive en una laptop, donde hay alguien
// para abrir la UI. En un deploy desatendido no hay nadie, y las reglas de
// admisión —lo único que decide qué trabajo toma esta máquina— no tenían
// forma declarativa: un pod que bootea con su volumen vacío arrancaba
// admitiendo TODO. Con un agente que pide `remote:*`, eso es la tarea del
// repo equivocado corriendo en la imagen equivocada.
//
// La regla es la misma que la del runner: **secreto → env; comportamiento →
// este archivo, que se commitea.** Por eso acá no hay ni un token:
// `API_AI_PROVIDER_TOKEN`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` e
// `IA_FLOW_SERVER_TOKEN` siguen viviendo en el entorno.
//
// ── Cómo se combina con lo que ya había ───────────────────────────────────
//
// El YAML es el arranque en frío, y no reemplaza a los otros dos:
//
//   env real       gana sobre el YAML (un `-e` puntual para debuggear, igual
//                  que en `applyRunnerEnv` — y lo pisado se reporta)
//   agent-host.json gana sobre los dos: es lo que el operador eligió en la
//                  pantalla, y un restart que lo revirtiera al archivo
//                  perdería justo la decisión recién tomada
//
// ── El módulo no importa `logger.js` ──────────────────────────────────────
//
// Igual que el del runner, y por lo mismo: corre antes que nada —es quien
// pone `LOG_LEVEL` en el entorno— y `logger.ts` congela el nivel al
// importarse. Por eso `applyAgentHostEnv` devuelve un reporte en vez de
// loguearlo, y lo loguea `index.ts` cuando el logger ya nació con el nivel
// correcto.
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { ADMISSION_FIELDS, ADMISSION_OPS } from './admission.js'

/** Path por convención dentro de la imagen. Se puede pasar otro por argv. */
export const DEFAULT_AGENT_HOST_CONFIG_PATH = '/app/config/agent-host.yaml'

const AdmissionRuleSchema = z
  .object({
    field: z.enum(ADMISSION_FIELDS),
    op: z.enum(ADMISSION_OPS),
    value: z.string(),
  })
  .strict()

export const AgentHostSettingsSchema = z
  .object({
    /** Puerto HTTP de este proceso. → PORT */
    port: z.number().int().positive().optional(),
    /** trace|debug|info|warn|error|fatal. → LOG_LEVEL */
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
    /** Quién es ESTE proceso en el collector. → IA_FLOW_INSTANCE_ID */
    instanceId: z.string().optional(),
    /**
     * Qué provider expone esta instancia. → AGENT_HOST_PROVIDER
     *
     * Sin validar contra la lista de ids acá a propósito: quién puede
     * construirse es cosa de `providers.ts`, que ya rechaza un id que no
     * conoce, y duplicar el enum haría que agregar un provider pidiera tocar
     * dos archivos.
     */
    provider: z.string().optional(),
    /** El `name` de la registración — la identidad estable de esta instancia
     *  entre restarts. → IA_FLOW_PROVIDER_NAME */
    providerName: z.string().optional(),
    /** Por qué URL lo alcanza el server al que se registra (no
     *  necesariamente donde escucha). → IA_FLOW_AGENT_HOST_PUBLIC_URL */
    publicUrl: z.string().optional(),
    /** Techo de runs simultáneos. → AGENT_HOST_MAX_CONCURRENT_RUNS */
    maxConcurrentRuns: z.number().int().positive().optional(),
    /** baseUrl del collector OTLP/HTTP; vacío = sink apagado.
     *  → OTEL_EXPORTER_OTLP_ENDPOINT */
    otelEndpoint: z.string().optional(),
    /** Headers para el collector (`k=v,k2=v2`) — el api-key va por env.
     *  → OTEL_EXPORTER_OTLP_HEADERS */
    otelHeaders: z.string().optional(),
    /** Kill switch del sink. → OTEL_SDK_DISABLED */
    otelDisabled: z.boolean().optional(),
  })
  .strict()

export const AgentHostRegisterSchema = z
  .object({
    /** baseUrls de servers ia-flow, alcanzables DESDE acá.
     *  → IA_FLOW_REGISTER_SERVER_URLS */
    servers: z.array(z.string()).optional(),
    /** → IA_FLOW_REGISTER_RETRIES */
    retries: z.number().int().positive().optional(),
    /** → IA_FLOW_REGISTER_RETRY_DELAY_MS */
    retryDelayMs: z.number().int().nonnegative().optional(),
  })
  .strict()

export const AgentHostWorkspaceSchema = z
  .object({
    /** Base de los clones persistentes. → AGENT_HOST_REPOS_BASE */
    reposBase: z.string().optional(),
    /** Base de los worktrees por task. → AGENT_HOST_WORKTREE_BASE */
    worktreeBase: z.string().optional(),
    /** → IA_FLOW_GIT_AUTHOR_NAME */
    gitAuthorName: z.string().optional(),
    /** → IA_FLOW_GIT_AUTHOR_EMAIL */
    gitAuthorEmail: z.string().optional(),
  })
  .strict()

/**
 * Reglas de admisión. NO tienen equivalente en env, y es deliberado: son una
 * lista de objetos, y la única forma de meterlas en una variable sería un JSON
 * embutido en un string — que es exactamente el formato que este archivo
 * viene a sacar del compose.
 */
export const AgentHostAdmissionSchema = z
  .object({
    rules: z.array(AdmissionRuleSchema).optional(),
  })
  .strict()

export const AgentHostConfigSchema = z
  .object({
    settings: AgentHostSettingsSchema.optional(),
    register: AgentHostRegisterSchema.optional(),
    workspace: AgentHostWorkspaceSchema.optional(),
    admission: AgentHostAdmissionSchema.optional(),
  })
  .strict()

export type AgentHostConfig = z.infer<typeof AgentHostConfigSchema>

/**
 * Dónde buscar el archivo: argv, después `AGENT_HOST_CONFIG`, después el path
 * por convención de la imagen.
 *
 * El tercero se marca como `explicit: false` porque cambia qué pasa si no
 * existe — ver `loadAgentHostConfig`.
 */
export function resolveAgentHostConfigPath(argv: string[]): {
  path: string
  explicit: boolean
} {
  const fromArgv = argv[2]?.trim()
  if (fromArgv) return { path: fromArgv, explicit: true }
  const fromEnv = Bun.env.AGENT_HOST_CONFIG?.trim()
  if (fromEnv) return { path: fromEnv, explicit: true }
  return { path: DEFAULT_AGENT_HOST_CONFIG_PATH, explicit: false }
}

/**
 * Lee y valida el archivo. Dos criterios que no son simétricos:
 *
 * - **Un path pedido a mano que no se puede leer TIRA.** Pedir una config y
 *   arrancar sin ella es peor que no arrancar: el proceso queda sano en el
 *   health check y admitiendo trabajo que no le toca.
 * - **El path por convención ausente NO tira** (devuelve `null`). Es lo que
 *   mantiene andando a los que hoy se configuran sólo con env vars: sin
 *   archivo, este módulo no cambia nada.
 *
 * Un archivo que existe pero no cumple el schema tira siempre, venga de donde
 * venga. Una regla de admisión mal tipeada es la clase de error que, tolerada,
 * se traduce en "este agent-host tomó una tarea que no era suya" tres días
 * después.
 */
export function loadAgentHostConfig(
  filePath: string,
  { explicit }: { explicit: boolean } = { explicit: true },
): AgentHostConfig | null {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    if (!explicit) return null
    throw new Error(
      `No se pudo leer el agent-host.yaml en '${filePath}': ${(err as Error).message}`,
    )
  }

  const result = AgentHostConfigSchema.safeParse(parseYaml(raw))
  if (!result.success) {
    throw new Error(`'${filePath}' no cumple AgentHostConfigSchema: ${result.error.message}`)
  }
  return result.data
}

const SETTINGS_ENV: Record<string, string> = {
  port: 'PORT',
  logLevel: 'LOG_LEVEL',
  instanceId: 'IA_FLOW_INSTANCE_ID',
  provider: 'AGENT_HOST_PROVIDER',
  providerName: 'IA_FLOW_PROVIDER_NAME',
  publicUrl: 'IA_FLOW_AGENT_HOST_PUBLIC_URL',
  maxConcurrentRuns: 'AGENT_HOST_MAX_CONCURRENT_RUNS',
  otelEndpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
  otelHeaders: 'OTEL_EXPORTER_OTLP_HEADERS',
  otelDisabled: 'OTEL_SDK_DISABLED',
}

const REGISTER_ENV: Record<string, string> = {
  retries: 'IA_FLOW_REGISTER_RETRIES',
  retryDelayMs: 'IA_FLOW_REGISTER_RETRY_DELAY_MS',
}

const WORKSPACE_ENV: Record<string, string> = {
  reposBase: 'AGENT_HOST_REPOS_BASE',
  worktreeBase: 'AGENT_HOST_WORKTREE_BASE',
  gitAuthorName: 'IA_FLOW_GIT_AUTHOR_NAME',
  gitAuthorEmail: 'IA_FLOW_GIT_AUTHOR_EMAIL',
}

export interface AgentHostEnvReport {
  applied: string[]
  overriddenByEnv: string[]
}

/**
 * Vuelca el YAML a `process.env`, que es lo que hace que el resto del proceso
 * —logger, `register.ts`, `providers.ts`, `state.ts`— no tenga que enterarse
 * de que este archivo existe. Sin esto habría dos formas de configurar cada
 * cosa, y tarde o temprano divergen.
 *
 * **El env real gana.** Un valor ya presente no se pisa: el YAML es lo que el
 * deploy declara, y un `-e` puntual es cómo se lo overridea sin editarlo
 * (mismo criterio que `applyRunnerEnv`). Lo salteado se devuelve para que
 * `index.ts` lo loguee — un override silencioso deja sin respuesta la
 * pregunta "¿por qué no aplica lo que dice el YAML?".
 *
 * `admission.rules` NO pasa por acá: no tiene env, y va directo al estado.
 */
export function applyAgentHostEnv(cfg: AgentHostConfig): AgentHostEnvReport {
  const applied: string[] = []
  const skipped: string[] = []

  const put = (name: string, value: string) => {
    if (process.env[name] !== undefined && process.env[name] !== '') {
      skipped.push(name)
      return
    }
    process.env[name] = value
    applied.push(name)
  }

  const putAll = (block: Record<string, unknown> | undefined, map: Record<string, string>) => {
    for (const [key, value] of Object.entries(block ?? {})) {
      const name = map[key]
      if (!name || value === undefined) continue
      put(name, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value))
    }
  }

  putAll(cfg.settings, SETTINGS_ENV)
  putAll(cfg.register, REGISTER_ENV)
  putAll(cfg.workspace, WORKSPACE_ENV)

  // La lista se aplana con comas, que es el formato que `registerSelf` y
  // `state.ts` ya parsean.
  if (cfg.register?.servers?.length) {
    put('IA_FLOW_REGISTER_SERVER_URLS', cfg.register.servers.join(','))
  }

  return { applied, overriddenByEnv: skipped }
}
