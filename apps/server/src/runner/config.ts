// Carga del `runner.yaml` — I/O en el borde, como manda la regla: el schema
// (`RunnerConfigSchema`, en `./config-schema.ts`) no toca disco;
// esto lee, parsea y valida.
//
// La segunda función de este módulo, `applyRunnerEnv`, es la que hace que el
// flavor `runner` pueda existir sin veinte env vars en el compose. Los knobs
// del dispatch NO se leen al importar: `dispatch/env.ts` documenta que cada
// uno hace `process.env[name]` en el momento de usarse, justo para que
// `envRepo.loadIntoProcess()` (que corre después) valga. Volcar el bloque
// `settings` al env antes de arrancar el daemon aprovecha esa misma
// propiedad — sin tocar una línea de esos paquetes, y sin una segunda forma
// de configurarlos que pueda divergir.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AgentDefinitionSchema, ProjectSchema, RepoDefSchema, RuleSchema } from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'
import type { z } from 'zod'
import { type RunnerConfig, RunnerConfigSchema } from './config-schema.js'

// Este módulo **no importa `logger.js`** a propósito. Corre antes que nada
// —es quien pone `LOG_LEVEL` en el entorno— y `logger.ts:21` congela el nivel
// en una const al importarse: bastaba con que el loader pidiera un logger para
// que el nivel declarado en el YAML llegara tarde. Por eso `applyRunnerEnv`
// devuelve su reporte en vez de loguearlo, y lo loguea el flavor, cuando el
// logger ya nació con el nivel correcto. Por lo mismo, el warning de abajo va
// por `console.warn` y no por un logger propio: crear uno acá reintroduciría
// exactamente el import que este comentario dice que no existe.

/** Path por convención dentro de la imagen. Se puede pasar otro por argv. */
export const DEFAULT_RUNNER_CONFIG_PATH = '/app/config/runner.yaml'

export function loadRunnerConfig(filePath: string): RunnerConfig {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    // Sin config no hay nada que correr: un runner que arranca "vacío" y se
    // queda escuchando sin proyectos es peor que uno que no arranca, porque
    // parece sano en el health check.
    throw new Error(`No se pudo leer el runner.yaml en '${filePath}': ${(err as Error).message}`)
  }

  const result = RunnerConfigSchema.safeParse(parseYaml(raw))
  if (!result.success) {
    throw new Error(`'${filePath}' no cumple RunnerConfigSchema: ${result.error.message}`)
  }

  const cfg = result.data
  const dir = dirname(filePath)
  // Los sueltos primero (son los globales), después lo que aporta cada carpeta
  // de proyecto. Ver `readProjectDirs` para por qué ese orden importa.
  const perProject = readProjectDirs(dir)
  const merged = {
    ...cfg,
    projects: [
      ...cfg.projects,
      ...readSectionDir(dir, 'projects', ProjectSchema),
      ...perProject.projects,
    ],
    repos: [...cfg.repos, ...readSectionDir(dir, 'repos', RepoDefSchema), ...perProject.repos],
    agents: [
      ...cfg.agents,
      ...readSectionDir(dir, 'agents', AgentDefinitionSchema),
      ...perProject.agents,
    ],
    rules: [...cfg.rules, ...readSectionDir(dir, 'rules', RuleSchema)],
  }

  // El "al menos un proyecto" se chequea DESPUÉS del merge, no en el schema:
  // pueden venir todos de la carpeta `projects/`, y un `.min(1)` sobre el
  // archivo solo rechazaría el caso normal de un deploy que partió sus
  // secciones. Nombrar los dos lugares importa — el error tiene que decir
  // dónde mirar.
  if (merged.projects.length === 0) {
    throw new Error(
      `'${filePath}' no declara ningún proyecto, ni inline ni en '${join(dir, 'projects')}/'. ` +
        'Un runner sin fuente no tiene qué escanear.',
    )
  }
  // Un roster sin reglas no dispara NADA desde la migración 059, que sacó la
  // activación del agente. Es un warn y no un throw porque un deploy puede
  // arrancar vacío a propósito (todavía no configuró nada); lo que no puede
  // pasar es que el silencio sea indistinguible de "está andando".
  if (merged.agents.length > 0 && merged.rules.length === 0) {
    console.warn(
      `[runner-config] El runner declara ${merged.agents.length} agente(s) pero ninguna regla ` +
        `(${filePath}) — nada los va a disparar. Desde la migración 059 el CUÁNDO vive en ` +
        '`rules:`, no en el agente.',
    )
  }

  return merged
}

/**
 * Convención: al lado del `runner.yaml` puede haber una carpeta por sección
 * —`agents/`, `repos/`, `projects/`— y cada `.yaml` de adentro se suma a lo
 * que la sección declare inline. Sin la carpeta, no pasa nada.
 *
 * Lo que hay acá son los **globales**: agentes sin `projectId`, que aplican a
 * todos los proyectos. Lo de un proyecto concreto vive en su propia carpeta
 * — ver `readProjectDirs`.
 *
 * Es convención y no una clave de config a propósito. Un `agentsDir: ./agents`
 * sería una tercera forma de decir dónde están los agentes (inline, la clave,
 * la carpeta), y la única pregunta que respondería —"¿y si los quiero en otro
 * lado?"— no la tiene nadie: el directorio del config ES el lugar.
 *
 * Existe porque el prompt de un agente son cientos de líneas. El roster de
 * `subscriptions-pipeline` son cuatro y dejan el archivo en ~1500, donde
 * cualquier diff es ilegible y dos personas tocando agentes distintos chocan
 * siempre.
 *
 * Genérico y no tres copias: son tres usos con la misma forma exacta, y sólo
 * cambia el schema con el que se valida.
 */
function readSectionDir<T extends z.ZodTypeAny>(
  configDir: string,
  section: 'agents' | 'repos' | 'projects' | 'rules',
  schema: T,
): z.infer<T>[] {
  const dir = join(configDir, section)
  if (!existsSync(dir)) return []

  // Orden alfabético **explícito**: `readdirSync` no lo garantiza, y de ese
  // orden depende cuál agente gana cuando ninguno declara `position` (ver
  // selectAgent, que corre "el primero por position" y cae al orden de
  // declaración). Dejárselo al filesystem haría que el mismo roster se
  // comporte distinto en dos máquinas.
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'))
    .sort()

  const out: z.infer<T>[] = []
  for (const name of names) out.push(...readEntries(join(dir, name), schema, section))
  return out
}

/**
 * Una carpeta por proyecto, con TODO lo suyo adentro.
 *
 *     projects/
 *       la-haus-116/
 *         project.yaml          ← la definición del proyecto (o <id>.yaml)
 *         agents/10-refiner.yaml
 *         agents/20-implementer.yaml
 *         repos/backend.yaml
 *       subscriptions.yaml      ← un proyecto sin nada propio: archivo suelto
 *
 * Agrupa por **dominio y no por tipo de archivo**, que es la regla que el
 * CLAUDE.md del repo pide para el código (`features/<dominio>/` en la web) y
 * que acá vale igual: lo que se toca junto es "todo lo del proyecto X", no
 * "todos los agentes de todos los proyectos".
 *
 * Y hay una razón concreta además de la estética: la selección de agentes ya
 * es por proyecto (`YamlAgentRepository.visibleTo`), así que la pregunta "¿en
 * qué orden quedan los agentes?" —de la que depende cuál gana sin `position`—
 * sólo tiene sentido dentro de un proyecto. Con esta forma queda local.
 *
 * El `projectId` sale del nombre de la carpeta, así que no se repite en cada
 * archivo. Los globales (agentes sin `projectId`, que aplican a todos) siguen
 * en `agents/` al nivel de arriba, y se cargan ANTES: es lo que espeja
 * `visibleTo`, donde un agente con `projectId` pisa al global del mismo id.
 */
function readProjectDirs(configDir: string): {
  projects: z.infer<typeof ProjectSchema>[]
  agents: z.infer<typeof AgentDefinitionSchema>[]
  repos: z.infer<typeof RepoDefSchema>[]
} {
  const empty = { projects: [], agents: [], repos: [] }
  const root = join(configDir, 'projects')
  if (!existsSync(root)) return empty

  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  const out: ReturnType<typeof readProjectDirs> = { projects: [], agents: [], repos: [] }
  for (const id of dirs) {
    const dir = join(root, id)

    // `project.yaml` o `<id>.yaml`: el primero se lee sin pensar, el segundo
    // es lo que sale natural al mover un archivo suelto adentro de su carpeta.
    const projectFile = [join(dir, 'project.yaml'), join(dir, `${id}.yaml`)].find((f) =>
      existsSync(f),
    )
    if (!projectFile) {
      throw new Error(
        `'${dir}/' no tiene 'project.yaml' ni '${id}.yaml'. Una carpeta de proyecto ` +
          'tiene que declarar el proyecto; si sólo querías agrupar archivos, usá `agents/`.',
      )
    }
    out.projects.push(...readEntries(projectFile, ProjectSchema, 'projects', { id }))

    for (const [section, schema, target] of [
      ['agents', AgentDefinitionSchema, out.agents],
      ['repos', RepoDefSchema, out.repos],
    ] as const) {
      const subdir = join(dir, section)
      if (!existsSync(subdir)) continue
      const files = readdirSync(subdir)
        .filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'))
        .sort()
      for (const name of files) {
        target.push(
          ...(readEntries(join(subdir, name), schema, section, { projectId: id }) as never[]),
        )
      }
    }
  }
  return out
}

/**
 * Lee un archivo de sección: puede traer una entrada suelta o una lista, y
 * `defaults` rellena lo que la entrada no declare.
 *
 * El parseo va envuelto porque `yaml` tira errores que no nombran el archivo:
 * un alias sin su anchor (típico al partir un YAML en carpetas, o al borrar la
 * entrada que definía el bloque compartido) sale como un `ReferenceError` crudo
 * con stack de la librería. Sin este contexto, el operador ve "Unresolved
 * alias: pipelinePrompts" y no tiene forma de saber en cuál de los N archivos
 * mirar.
 */
function readEntries<T extends z.ZodTypeAny>(
  file: string,
  schema: T,
  section: string,
  defaults?: Record<string, unknown>,
): z.infer<T>[] {
  let parsed: unknown
  try {
    parsed = parseYaml(readFileSync(file, 'utf-8'))
  } catch (err) {
    throw new Error(`'${file}' no es YAML válido: ${(err as Error).message}`)
  }

  // Una entrada suelta o una lista — que elija el autor, en vez de obligarlo a
  // envolver en `- ` un objeto de 300 líneas.
  const raw = Array.isArray(parsed) ? parsed : [parsed]
  const items = defaults
    ? raw.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? // Los defaults van PRIMERO: lo que la entrada declare los pisa. Es
            // un default, no una imposición — un caso raro puede contradecir
            // la convención sin salirse de ella.
            { ...defaults, ...(item as Record<string, unknown>) }
          : item,
      )
    : raw

  const validated = schema.array().safeParse(items)
  if (!validated.success) {
    throw new Error(
      `'${file}' no valida contra el schema de ${section}: ${validated.error.message}`,
    )
  }
  return validated.data
}

/**
 * La config del flavor `runner`, para que el composition root sepa que está
 * en ese modo y de dónde sacar cada sección.
 *
 * Es estado de proceso, como `envRepo.loadIntoProcess()`, y por el mismo
 * motivo: `container.ts` es un módulo con efectos al importarse, así que no
 * puede recibirla por parámetro. `main.ts` la deja acá ANTES de importar el
 * flavor; `null` significa "flavor full", que es el comportamiento de siempre.
 */
let loaded: RunnerConfig | null = null
let envReport: RunnerEnvReport | null = null

export function setRunnerConfig(cfg: RunnerConfig, report?: RunnerEnvReport): void {
  loaded = cfg
  envReport = report ?? null
}

export function getRunnerConfig(): RunnerConfig | null {
  return loaded
}

/** Qué del YAML llegó al entorno y qué venía pisado. Lo loguea el flavor. */
export function getRunnerEnvReport(): RunnerEnvReport | null {
  return envReport
}

/**
 * Traducción declarada de cada knob a la env var que ya lo lee. Es una tabla
 * y no un `env: {}` crudo en el YAML a propósito: así un típo es un error de
 * schema en el boot (`.strict()`) y no una variable que nadie aplicó nunca.
 */
const SETTINGS_ENV: Record<string, string> = {
  daemonMode: 'IA_FLOW_DAEMON_MODE',
  logLevel: 'LOG_LEVEL',
  instanceId: 'IA_FLOW_INSTANCE_ID',
  port: 'IA_FLOW_SERVER_PORT',
  maxConcurrentDispatches: 'IA_FLOW_MAX_CONCURRENT_DISPATCHES',
  pollIntervalMs: 'IA_FLOW_POLL_INTERVAL_MS',
  webhookFallbackMs: 'IA_FLOW_WEBHOOK_FALLBACK_MS',
  startupScan: 'IA_FLOW_STARTUP_SCAN',
  crashRecovery: 'IA_FLOW_CRASH_RECOVERY',
  fileSimplifier: 'IA_FLOW_FILE_SIMPLIFIER',
  fatalPolicy: 'IA_FLOW_FATAL_POLICY',
  otelEndpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
  otelHeaders: 'OTEL_EXPORTER_OTLP_HEADERS',
  otelDisabled: 'OTEL_SDK_DISABLED',
}

const GITHUB_ENV: Record<string, string> = {
  mode: 'IA_FLOW_GITHUB_AUTH_MODE',
  appId: 'IA_FLOW_GITHUB_APP_ID',
  installationId: 'IA_FLOW_GITHUB_APP_INSTALLATION_ID',
  privateKeyPath: 'IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH',
}

/**
 * Vuelca `settings`, `github` y `upstream` a `process.env`.
 *
 * **El env real gana.** Un valor ya presente en el ambiente no se pisa: el
 * YAML es lo que el deploy declara, y un `-e` puntual es cómo se lo overridea
 * para debuggear sin editar el archivo (mismo criterio que Vite con los
 * `.env`). Lo que se saltea se loguea — un override silencioso deja sin
 * respuesta la pregunta "¿por qué no aplica lo que dice el YAML?".
 *
 * Devuelve qué se aplicó y qué venía pisado por el ambiente, para que el
 * flavor lo loguee.
 *
 * Tiene que correr ANTES de importar el flavor: `logger.ts` lee `LOG_LEVEL`
 * al importarse, así que un import estático dejaría el nivel del YAML llegando
 * tarde. Es la razón de que `main.ts` cargue los flavors con `await import()`.
 */
export interface RunnerEnvReport {
  applied: string[]
  overriddenByEnv: string[]
}

export function applyRunnerEnv(cfg: RunnerConfig): RunnerEnvReport {
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

  for (const [key, value] of Object.entries(cfg.settings ?? {})) {
    const name = SETTINGS_ENV[key]
    if (!name || value === undefined) continue
    // Los flags booleanos del engine leen '0'/'false'/'no'/'off' como apagado
    // (envFlag en dispatch/catch-up.ts); cualquier otra cosa es encendido.
    put(name, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value))
  }

  for (const [key, value] of Object.entries(cfg.github ?? {})) {
    const name = GITHUB_ENV[key]
    if (name && value !== undefined) put(name, String(value))
  }

  if (cfg.upstream) {
    // Una sola URL base en el YAML: las dos rutas se derivan. Declararlas por
    // separado —como hacían las env vars que esto reemplaza— repite el mismo
    // host y permite que apunten a daemons distintos, que nunca es la
    // intención.
    const base = cfg.upstream.url.replace(/\/+$/, '')
    put('IA_FLOW_REMOTE_LOG_URL', `${base}/api/remote-logs`)
    put('IA_FLOW_REMOTE_EXECUTIONS_URL', `${base}/api/remote-executions`)
    if (cfg.upstream.token) put('IA_FLOW_REMOTE_LOG_TOKEN', cfg.upstream.token)
  }

  return { applied, overriddenByEnv: skipped }
}
