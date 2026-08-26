// Carga del `runner.yaml` — I/O en el borde, como manda la regla: el schema
// (`RunnerConfigSchema`, en @ia-flow/shared) es contract-only y no toca disco;
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
import { readFileSync } from 'node:fs'
import { type RunnerConfig, RunnerConfigSchema } from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'

// Este módulo **no importa `logger.js`** a propósito. Corre antes que nada
// —es quien pone `LOG_LEVEL` en el entorno— y `logger.ts:21` congela el nivel
// en una const al importarse: bastaba con que el loader pidiera un logger para
// que el nivel declarado en el YAML llegara tarde. Por eso `applyRunnerEnv`
// devuelve su reporte en vez de loguearlo, y lo loguea el flavor, cuando el
// logger ya nació con el nivel correcto.

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
  return result.data
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
