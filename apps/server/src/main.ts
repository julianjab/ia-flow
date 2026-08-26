// Entrypoint único del server. Elige un flavor y le cede el proceso.
//
// Es lo que permite que la imagen del runner no versione ningún script: su
// `ENTRYPOINT` es este binario y su `CMD` es una palabra —el flavor—, en vez
// de un `entrypoint.sh` que hay que mantener en paralelo al código que arranca.
//
//   ia-flow                          → flavor `full` (default)
//   ia-flow runner                   → flavor `runner`, config en /app/config/runner.yaml
//   ia-flow runner /otro/config.yaml → mismo flavor, otro archivo
//
// ── Dos decisiones que parecen detalles y no lo son ──────────────────────
//
// **Los flavors se importan con `await import()`, no estáticamente.** El
// bloque `settings` del runner.yaml se vuelca a `process.env` acá abajo, y
// `logger.ts` lee `LOG_LEVEL` **al importarse**. Con un import estático el
// logger nacería antes de esa línea y el nivel declarado en el YAML llegaría
// tarde, en silencio. Lo mismo vale para `container.ts`, que se evalúa entero
// al importarse y necesita ver la config ya cargada.
//
// **Los specifiers son literales, no `./flavors/${flavor}.js`.** El template
// literal no se puede empaquetar: `bun build` lo deja tal cual y el bundle
// resultante muere en runtime con `Cannot find module`. Con un `switch` el
// bundler ve los dos módulos y los incluye, sin perder la evaluación
// perezosa —que es lo único que este archivo necesita de verdad.
//
// Por lo mismo, este archivo **no importa `./logger.js`**: hacerlo lo
// evaluaría antes de `applyRunnerEnv`, y el `LOG_LEVEL` del YAML llegaría
// tarde — el smoke test del flavor lo mostró en el primer intento, con líneas
// INFO saliendo bajo un `logLevel: warn` declarado. Lo poco que hay que decir
// antes de que el logger exista va por `console`.

const FLAVORS = ['full', 'runner'] as const
type Flavor = (typeof FLAVORS)[number]

function parseFlavor(raw: string | undefined): Flavor {
  if (!raw) return 'full'
  if ((FLAVORS as readonly string[]).includes(raw)) return raw as Flavor
  // Un flavor desconocido es un typo en el `CMD` del contenedor, y arrancar el
  // `full` en su lugar significaría exponer 24 routers sin auth donde alguien
  // pidió un runner headless. Es exactamente el caso que tiene que gritar.
  throw new Error(`Flavor desconocido: '${raw}'. Válidos: ${FLAVORS.join(', ')}.`)
}

const flavor = parseFlavor(process.argv[2]?.trim())

if (flavor === 'runner') {
  // Import diferido también acá: el loader arrastra el schema y el parser de
  // YAML, que el flavor `full` no necesita.
  const { DEFAULT_RUNNER_CONFIG_PATH, applyRunnerEnv, loadRunnerConfig, setRunnerConfig } =
    await import('./infrastructure/config/runner-config.js')

  const path = process.argv[3]?.trim() || DEFAULT_RUNNER_CONFIG_PATH
  const cfg = loadRunnerConfig(path)
  // El orden importa: primero el env (para el logger y los knobs del
  // dispatch), después la config global (para `container.ts`), y recién ahí
  // el flavor.
  const envReport = applyRunnerEnv(cfg)
  setRunnerConfig(cfg, envReport)

  await import('./flavors/runner.js')
} else {
  await import('./flavors/full.js')
}
