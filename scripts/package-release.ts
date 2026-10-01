#!/usr/bin/env bun
// Arma el artefacto publicable del runner headless (`apps/runner-v2`) para una release.
//
//   bun run scripts/package-release.ts [version]
//
// Produce, en dist/artifacts/:
//
//   ia-flow-runner.js                 el bundle pelado — un `ADD` de una línea
//   ia-flow-runner-<version>.tar.gz   el bundle + VERSION + BUN_VERSION + Dockerfile.example
//   SHA256SUMS                        para `ADD --checksum` y para verificar a mano
//
// ── Por qué un bundle y no una imagen ─────────────────────────────────────
//
// Una imagen le impone al consumidor la base que elegimos nosotros; el bundle se referencia con
// un `ADD` desde su Dockerfile, sobre la base que ya use (git, toolchains, los MCP que levante).
//
// ── Las actions de la config ──────────────────────────────────────────────
//
// La config (runner.yaml, pipelines, agentes) NO va en el bundle: la trae cada deploy. Sus
// actions son `.ts` que importan `@ia-flow/*` y `zod`; el bundle se los sirve como módulos
// virtuales (`apps/runner-v2/src/bundle/`), así que la carpeta de config puede vivir en cualquier
// lado, sin `node_modules` al lado.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** La versión de Bun con la que se construye y se prueba el bundle — la misma de `setup-bun` en
 *  CI y release, y la que se anuncia adentro del artefacto. */
export const BUN_VERSION = '1.4.2'

const ROOT = join(import.meta.dir, '..')
const APP_DIR = join(ROOT, 'apps', 'runner-v2')
const OUT = join(ROOT, 'dist', 'artifacts')
const NAME = 'ia-flow-runner'

const version = (
  process.argv[2] ??
  Bun.env.VERSION ??
  (await Bun.file(join(ROOT, 'version.txt')).text())
)
  .trim()
  .replace(/^v/, '')
const repo = Bun.env.GITHUB_REPOSITORY ?? 'julianjab/ia-flow'

if (Bun.version !== BUN_VERSION) {
  console.error(`✗ el bundle se arma con Bun ${BUN_VERSION}, no con ${Bun.version}`)
  process.exit(1)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const js = join(OUT, `${NAME}.js`)
// Desde apps/runner-v2: Bun toma `experimentalDecorators` (el de `@memoize`) del tsconfig del
// directorio desde el que corre, no del de cada archivo.
const build = Bun.spawnSync(
  [
    'bun',
    'build',
    '--target=bun',
    'src/main.ts',
    `--outfile=${js}`,
    `--define=process.env.IA_FLOW_RUNNER_VERSION=${JSON.stringify(version)}`,
  ],
  { cwd: APP_DIR },
)
if (build.exitCode !== 0) {
  console.error(`✗ bun build: ${build.stderr.toString()}`)
  process.exit(1)
}

// Un decorator TC39 en vez del legacy deja a `@memoize` sin `descriptor` y la bandeja de la web
// muere en el primer request — sin ningún error al construir.
const bundled = await Bun.file(js).text()
if (!bundled.includes('__legacyDecorateClassTS')) {
  console.error('✗ el bundle no trae los decorators legacy: @memoize quedaría roto')
  process.exit(1)
}

const dockerfile = `# ia-flow runner — v${version}
#
# Este Dockerfile NO necesita el repo de ia-flow: baja el bundle publicado y lo corre sobre la
# config de este deploy (runner.yaml + pipelines + agentes + actions).
FROM oven/bun:${BUN_VERSION}-slim

# git + CAs: el workspace clona y pushea por https.
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git ca-certificates \\
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# \`ADD <url>\` baja el archivo como -rw------- root: sin --chown/--chmod, USER bun no lo lee.
ADD --chown=bun:bun --chmod=644 https://github.com/${repo}/releases/download/v${version}/${NAME}.js /app/runner.js
COPY --chown=bun:bun config/ /app/config/

ENV RUNNER_CONFIG_DIR=/app/config \\
    WORKSPACE_DIR=/state/workspaces
VOLUME ["/state"]
RUN mkdir -p /state && chown -R bun:bun /state
USER bun

EXPOSE 3001
# GET /health contesta 200 mientras el proceso vive.
ENTRYPOINT ["bun", "run", "/app/runner.js", "--serve"]
`

const stage = join(OUT, `${NAME}-${version}`)
mkdirSync(stage, { recursive: true })
writeFileSync(join(stage, 'runner.js'), bundled)
writeFileSync(join(stage, 'Dockerfile.example'), dockerfile)
writeFileSync(join(stage, 'VERSION'), `${version}\n`)
writeFileSync(join(stage, 'BUN_VERSION'), `${BUN_VERSION}\n`)
const tar = Bun.spawnSync(['tar', '-czf', `${NAME}-${version}.tar.gz`, `${NAME}-${version}`], {
  cwd: OUT,
})
if (tar.exitCode !== 0) {
  console.error(`✗ tar: ${tar.stderr.toString()}`)
  process.exit(1)
}
rmSync(stage, { recursive: true, force: true })

const sums: string[] = []
for (const file of [`${NAME}.js`, `${NAME}-${version}.tar.gz`]) {
  const hash = new Bun.CryptoHasher('sha256')
  hash.update(new Uint8Array(await Bun.file(join(OUT, file)).arrayBuffer()))
  sums.push(`${hash.digest('hex')}  ${file}`)
}
writeFileSync(join(OUT, 'SHA256SUMS'), `${sums.join('\n')}\n`)

const kb = Math.round(Bun.file(js).size / 1024)
console.log(`✓ ${NAME}.js (${kb} KB) + tarball → dist/artifacts/ (v${version}, Bun ${BUN_VERSION})`)
