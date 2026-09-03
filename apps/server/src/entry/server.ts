// Entrypoint del server completo. El cuerpo real vive en `server-boot.ts`;
// este archivo sólo decide, ANTES de importarlo, si hay una config de deploy
// (`runner.yaml`) para precargar.
//
// Sin argumento: comportamiento de siempre — el container resuelve todo por
// SQLite y env (`setPreloadedConfig` no se llama).
//
// Con un path de YAML (mismo formato que usa `runner.ts`): se vuelca
// `settings` al env con `applyRunnerEnv` y se preloadea `projects/repos/
// agents/rules/mcp` con `setPreloadedConfig` — así el flavor `full` (WebSocket
// + providers de terminal + 24 routers) arranca con la MISMA config de agentes
// que un deploy headless, útil para probar el live-mode de la web contra un
// roster que hoy sólo corre como `runner`.
//
//   bun run --cwd apps/server dev -- /ruta/a/runner.local.yaml
//
// Mismo motivo que en `runner.ts` para el `await import()`: `applyRunnerEnv`
// tiene que correr antes de que se evalúe `logger.ts` (congela `LOG_LEVEL` al
// importarse), y `setPreloadedConfig` antes de `container.js` (se evalúa
// entero al importarse). Un import estático de `server-boot.js` acá arriba
// rompería ese orden.
const configPath = process.argv[2]?.trim()

if (configPath) {
  const { applyRunnerEnv, loadRunnerConfig } = await import('../runner/config.js')
  const cfg = loadRunnerConfig(configPath)
  applyRunnerEnv(cfg)

  const { setPreloadedConfig } = await import('../composition/preloaded.js')
  setPreloadedConfig({
    projects: cfg.projects,
    repos: cfg.repos,
    agents: cfg.agents,
    rules: cfg.rules,
    mcp: cfg.mcp,
    remoteProviders: cfg.settings?.remoteProviders ?? true,
    workspace: cfg.settings?.workspace ?? false,
  })
}

await import('./server-boot.js')

// Para que TS trate el archivo como módulo y admita los `await import()` de
// arriba — no hay ningún import estático que lo haga, y es a propósito.
export {}
