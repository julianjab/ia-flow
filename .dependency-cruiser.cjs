/**
 * Las fronteras del repo, verificadas: `bun run lint:boundaries` (y `bun run check`).
 *
 * Cada regla es una AUSENCIA ("X nunca importa Y"), con un `comment` que dice qué hacer si salta:
 * es lo que lee quien —persona o agente— rompió la regla. El mapa de qué va dónde está en los
 * AGENTS.md; acá sólo lo que se puede verificar.
 */
const { readdirSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')

const RUNNER = '^apps/runner-v2/src/'

/** Cada paquete del workspace (`packages/**` y `apps/*`): su carpeta y sus `@ia-flow/*` declarados. */
function workspacePackages() {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const path = join(dir, entry)
      if (!statSync(path).isDirectory()) continue
      try {
        const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
        const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
        found.push({
          dir: path,
          name: pkg.name,
          deps: deps.filter((d) => d.startsWith('@ia-flow/')),
        })
      } catch {
        walk(path, depth + 1)
      }
    }
  }
  walk('packages', 0)
  walk('apps', 0)
  return found
}

/** Una regla por paquete: sólo importa los paquetes del monorepo que declara en su package.json
 *  (depcruise ve los del workspace como rutas locales, no como dependencias npm). */
function declaredDepsRules() {
  const packages = workspacePackages()
  const dirOf = new Map(packages.map((pkg) => [pkg.name, pkg.dir]))
  const escapeRegex = (dir) => dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return packages.map((pkg) => {
    const allowed = [pkg.dir, ...pkg.deps.map((dep) => dirOf.get(dep)).filter(Boolean)]
    return {
      name: 'package-deps-declared',
      severity: 'error',
      comment: `${pkg.name} importa un paquete del monorepo que no declara en su package.json. Si la dependencia es correcta, sumala a \`dependencies\` (y al grafo de CLAUDE.md); si no, la lógica está en el paquete equivocado.`,
      from: { path: `^${escapeRegex(pkg.dir)}/` },
      to: { path: '^packages/', pathNot: `^(${allowed.map(escapeRegex).join('|')})/` },
    }
  })
}

/** Los paquetes que no dependen de nada del monorepo (CLAUDE.md → "Cross-package dependency graph"). */
const STANDALONE = [
  'packages/github/auth',
  'packages/github/webhook',
  'packages/slack/api',
  'packages/slack/socket',
  'packages/telemetry',
  'packages/shared',
  'packages/rules',
]

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Un ciclo de imports en runtime. Sacá lo que comparten los dos módulos a un tercero que ambos importen (ver `isAgent.ts`, `providerId.ts`), o que uno dependa del otro sólo por tipos.',
      from: {},
      // Los ciclos sólo de tipos (`import type`) no existen en runtime: no cuentan.
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Un import que no resuelve: el archivo no existe o el paquete no está instalado.',
      from: {},
      to: { couldNotResolve: true },
    },
    ...declaredDepsRules(),
    {
      name: 'packages-never-import-apps',
      severity: 'error',
      comment:
        'Un paquete no conoce a las apps. Si necesita algo de runner-v2, eso es del paquete (movelo) o entra como parámetro/puerto.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'standalone-packages-stay-standalone',
      severity: 'error',
      comment:
        'Este paquete no depende de nada del monorepo (auth, webhook, slack-api, slack-socket, telemetry, shared). Lo que necesite, entra por parámetro.',
      from: { path: `^(${STANDALONE.join('|')})/` },
      to: { path: '^packages/', pathNot: `^(${STANDALONE.join('|')})/` },
    },
    {
      name: 'engine-core-has-no-infra',
      severity: 'error',
      comment:
        'agent-engine (core) es el contrato puro: no depende de ningún paquete de infra, sólo de telemetry y de rules (condiciones y plantillas puras). La flecha va de la infra (provider, GitHub, disco) hacia el contrato.',
      from: { path: '^packages/agent-engine/core/src/' },
      to: { path: '^packages/', pathNot: '^packages/(agent-engine/core|telemetry|rules)/' },
    },
    {
      name: 'nothing-imports-main',
      severity: 'error',
      comment:
        'main.ts es el composition root: arranca el runner. Lo que necesites de ahí, movelo a su carpeta.',
      from: { pathNot: `${RUNNER}main\\.ts$` },
      to: { path: `${RUNNER}main\\.ts$` },
    },
    {
      name: 'http-is-only-the-edge',
      severity: 'error',
      comment:
        'http/ es el borde: servidor, rutas y SSE, sin lógica. Recibe y delega en intake/ (un webhook) o en la API que le pasa quien lo monta. La lógica va en su carpeta de dominio.',
      from: { path: `${RUNNER}http/` },
      to: { path: RUNNER, pathNot: `${RUNNER}(http/|intake/|boot\\.ts$)` },
    },
    {
      name: 'intake-knows-no-features',
      severity: 'error',
      comment:
        'intake/ traduce un webhook o un mensaje de Slack al evento de su task. No conoce el borde HTTP, la bandeja, el asistente, el storage ni los providers: si los necesita, eso no es intake.',
      from: { path: `${RUNNER}intake/` },
      to: { path: `${RUNNER}(http|inbox|assistant|storage|providers|mcp)/` },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // `.config/` es la definición de un deploy: sus imports los resuelven los módulos virtuales
    // del runner (src/bundle/), no node_modules. apps/web tiene su propio alias (`@/`) y su lint.
    exclude: { path: '(^|/)(node_modules|dist|\\.state|\\.config)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.js', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
