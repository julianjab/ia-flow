// Entrypoint del engine headless.
//
// Hermano de `server.ts`: mismo composition root, mismo daemon. La diferencia
// es que ESTE resuelve su config antes —un `runner.yaml` con sus carpetas por
// sección— y se la entrega al container ya hecha (`setPreloadedConfig`), en vez
// de que el container vaya a buscarla. Por eso `infrastructure/` y
// `composition/` no tienen una sola mención a "runner": la única capa que sabe
// de YAMLs es esta carpeta y `../runner/`.
//
// ── Por qué no hay un solo import estático ────────────────────────────────
//
// El orden del arranque no es negociable, y las dos razones son de timing:
//
//   1. `applyRunnerEnv` vuelca `settings` al entorno, y tiene que correr ANTES
//      de que se evalúe cualquier módulo que toque `logger.ts` — que congela
//      `LOG_LEVEL` al importarse. Un import estático del logger acá dejaría el
//      nivel del YAML llegando tarde, en silencio.
//   2. `setPreloadedConfig` tiene que correr ANTES de importar `container.js`,
//      que se evalúa entero al importarse y ahí decide sus repositorios.
//
// De ahí que todo el cuerpo viva detrás de `await import()`. Y los specifiers
// son literales, no interpolados: `bun build` no puede resolver un template
// literal — lo deja tal cual y el bundle muere en runtime con "Cannot find
// module". Verificado con un caso mínimo.
//
//   ia-flow-runner                          → /app/config/runner.yaml
//   ia-flow-runner /otro/config.yaml        → ese archivo
const { DEFAULT_RUNNER_CONFIG_PATH, applyRunnerEnv, loadRunnerConfig, setRunnerConfig } =
  await import('../runner/config.js')

const path = process.argv[2]?.trim() || DEFAULT_RUNNER_CONFIG_PATH
const cfg = loadRunnerConfig(path)
const envReport = applyRunnerEnv(cfg)
setRunnerConfig(cfg, envReport)

// Lo que el container va a usar en vez de construirlo. Nótese que acá se
// traducen los conceptos del YAML a los del composition root: `settings.api`
// y `settings.remoteProviders` son vocabulario de este deploy; `workspace` y
// `remoteProviders` de `PreloadedConfig` son lo que el container entiende.
const { setPreloadedConfig } = await import('../composition/preloaded.js')
setPreloadedConfig({
  projects: cfg.projects,
  repos: cfg.repos,
  agents: cfg.agents,
  mcp: cfg.mcp,
  remoteProviders: cfg.settings?.remoteProviders ?? true,
  // Default apagado: un roster headless que sólo lee y escribe por el MCP de
  // GitHub no necesita checkout. Pero es un DEFAULT, no una propiedad del
  // flavor — un roster que escribe código lo prende con `settings.workspace`
  // y su `anthropic-api` (el piso que corre cuando ningún remoto acepta)
  // aterriza en el mismo worktree que le habría dado un agent-host. Ver el
  // comentario del knob en runner/config-schema.ts.
  workspace: cfg.settings?.workspace ?? false,
})

await import('./runner-boot.js')

// Para que TS trate el archivo como módulo y admita los `await import()` de
// arriba — no hay ningún import estático que lo haga, y es a propósito.
export {}
