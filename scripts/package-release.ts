#!/usr/bin/env bun
// Arma los artefactos publicables de una release.
//
//   bun run scripts/package-release.ts [version]
//
// Produce, en dist/artifacts/, para cada una de las tres apps:
//
//   ia-flow-<app>.js              el bundle pelado — un `ADD` de una línea
//   ia-flow-<app>-<version>.tar.gz  el bundle + metadata + Dockerfile de ejemplo
//   SHA256SUMS                    para `ADD --checksum` y para verificar a mano
//
// ── Por qué un artefacto y no una imagen ─────────────────────────────────
//
// Publicar imágenes obliga a quien las consume a heredar la base que NOSOTROS
// elegimos: nuestra versión de Debian, nuestros paquetes, nuestro usuario. Un
// bundle se referencia desde el Dockerfile de cualquiera, sobre la base que ya
// use, y pesa 2 MB.
//
// ── Por qué los DOS formatos ─────────────────────────────────────────────
//
// El `.js` pelado existe porque `ADD <url>` NO desempaqueta archivos remotos
// (sólo los locales), así que con un tarball el consumidor necesita sí o sí un
// `RUN tar -xzf`. Con el .js suelto su Dockerfile es literalmente un `ADD`.
// El tarball existe para el caso contrario: trae el VERSION, el BUN_VERSION y
// un Dockerfile de ejemplo, o sea que se puede leer sin volver a este repo.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** La versión de Bun con la que el bundle está probado. NO es cosmética: Bun
 *  1.4.x cambió el transform de decorators legacy y rompe `@memoize`
 *  (packages/shared/src/cache.ts), que está en el grafo de las tres apps. Un
 *  consumidor que use otra base se lleva ese bug sin ninguna señal, así que la
 *  versión viaja DENTRO del artefacto y no sólo en un README. */
const BUN_VERSION = '1.1.30'

const APPS = [
  {
    name: 'server',
    entry: 'apps/server/src/entry/server.ts',
    title: 'ia-flow — server completo (API + WebSocket)',
    port: 3001,
    env: [
      'IA_FLOW_CONFIG_DIR=/state',
      'IA_FLOW_DB_PATH=/state/ia-flow.sqlite',
      // Explícito: `local-fs` lo resuelve relativo al módulo, y en un bundle
      // eso no apunta a ningún lado. Ver composition/container.ts.
      'IA_FLOW_TASKS_ROOT=/state/tasks',
      'IA_FLOW_SERVER_PORT=3001',
      'LOG_PLAIN=true',
    ],
    needsGit: true,
    note: 'La API no tiene auth propia salvo que configures IA_FLOW_API_TOKEN.\n# Publicá el puerto en loopback o detrás de algo que autentique.',
  },
  {
    name: 'runner',
    entry: 'apps/server/src/entry/runner.ts',
    title: 'ia-flow — engine headless (flavor runner)',
    port: 3001,
    env: ['IA_FLOW_CONFIG_DIR=/state', 'IA_FLOW_DB_PATH=/state/ia-flow.sqlite', 'LOG_PLAIN=true'],
    needsGit: true,
    note: 'Su config entra por un runner.yaml montado en runtime; el path va\n# como argv[1] (default /app/config/runner.yaml).',
  },
  {
    name: 'gateway',
    entry: 'apps/ai-provider-gateway/src/index.ts',
    title: 'ia-flow — gateway de providers de IA',
    port: 3002,
    env: [
      'IA_FLOW_CONFIG_DIR=/state',
      'PORT=3002',
      'LOG_PLAIN=true',
      'IA_FLOW_GATEWAY_LOG_FILE=""',
    ],
    needsGit: true,
    note: 'API_AI_PROVIDER_TOKEN es obligatoria: sin ella todo responde 500.',
  },
] as const

const version = (process.argv[2] ?? Bun.env.VERSION ?? '0.0.0-dev').replace(/^v/, '')

/** De dónde bajar los artefactos. Sale del entorno de Actions cuando corre en
 *  CI; el fallback es para correrlo a mano. Hardcodearlo haría que un fork —o
 *  un rename del repo— publique artefactos cuyo `Dockerfile.example` apunta a
 *  una URL que da 404. */
const REPO = Bun.env.GITHUB_REPOSITORY ?? 'julianjab/ia-flow'
const OUT = join(import.meta.dir, '..', 'dist', 'artifacts')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

function dockerfile(app: (typeof APPS)[number]): string {
  const url = `https://github.com/${REPO}/releases/download/v${version}/ia-flow-${app.name}.js`
  return `# ${app.title} — v${version}
#
# Este Dockerfile NO necesita el repo de ia-flow: baja el bundle publicado y lo
# corre. Copiá esto donde quieras y cambiá la base si te sirve otra.
#
# ⚠️  La versión de Bun NO es libre. El bundle está construido y probado con
#     ${BUN_VERSION}; Bun 1.4.x rompe \`@memoize\`, que está en el grafo de esta
#     app, y lo hace SIN ningún error visible. Si subís esta base, verificá
#     antes que el issue #80 del repo esté cerrado.
FROM oven/bun:${BUN_VERSION}-slim
${
  app.needsGit
    ? `
# git + CAs: el provisioner de workspace clona y pushea. Sin el bundle de CAs,
# un clone por https falla con "server certificate verification failed".
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git ca-certificates \\
 && rm -rf /var/lib/apt/lists/*
`
    : ''
}
WORKDIR /app

# Un solo archivo, ~2 MB. Nada de node_modules: el bundle es autosuficiente.
#
# \`--chown\` y \`--chmod\` NO son opcionales: \`ADD <url>\` baja el archivo como
# \`-rw------- root root\`, así que con el \`USER bun\` de más abajo el ENTRYPOINT
# moriría con "permission denied" — y el error no menciona al ADD por ningún
# lado. (\`COPY\` de un archivo local no tiene el problema: conserva su modo.)
ADD --chown=bun:bun --chmod=644 ${url} /app/${app.name}.js

ENV ${app.env.join(' \\\n    ')}
VOLUME ["/state"]

# Non-root: Pod Security Standards en \`restricted\` rechaza root. La base ya
# trae el usuario \`bun\` (uid 1000); lo que falta es que /state le pertenezca.
RUN mkdir -p /state && chown -R bun:bun /state
USER bun

EXPOSE ${app.port}

# ${app.note}
ENTRYPOINT ["bun", "run", "/app/${app.name}.js"]
`
}

function readme(app: (typeof APPS)[number]): string {
  return `# ${app.title}

Versión: **${version}** · Construido con Bun **${BUN_VERSION}**

## Qué hay acá

    ${app.name}.js         el bundle. Un archivo, sin node_modules.
    Dockerfile.example     copiá/pegá y andá
    VERSION / BUN_VERSION  lo mismo, en texto plano

## Cómo se usa

El bundle necesita **Bun** para correr — no es un binario. Lo que NO necesita
es \`node_modules\`, ni el repo, ni un \`bun install\`:

    bun run ${app.name}.js

En una imagen, con una sola línea:

    FROM oven/bun:${BUN_VERSION}-slim
    ADD --chmod=644 https://github.com/${REPO}/releases/download/v${version}/ia-flow-${app.name}.js /app/${app.name}.js
    ENTRYPOINT ["bun", "run", "/app/${app.name}.js"]

Ver \`Dockerfile.example\` para la versión completa (git, /state, non-root).

## La versión de Bun no es libre

El bundle está probado con **${BUN_VERSION}**. Bun 1.4.x cambió el transform de
decorators legacy y rompe \`@memoize\`, que está en el grafo de esta app — y lo
rompe en silencio, sin error. Por eso el número viaja adentro del artefacto.

## Verificar la descarga

    sha256sum -c SHA256SUMS

O directo en el Dockerfile, que además falla el build si el archivo cambió:

    ADD --chmod=644 --checksum=sha256:<el-de-SHA256SUMS> <url> /app/${app.name}.js

## Ojo con los permisos si corrés non-root

\`ADD <url>\` baja el archivo como \`-rw------- root root\`. Si tu imagen usa un
\`USER\` no-root (y debería), hace falta \`--chown=<user>:<group> --chmod=644\` o
el arranque muere con "permission denied" sin mencionar al ADD.
`
}

const sums: string[] = []

for (const app of APPS) {
  const js = join(OUT, `ia-flow-${app.name}.js`)

  const build = Bun.spawnSync(['bun', 'build', '--target=bun', app.entry, `--outfile=${js}`])
  if (build.exitCode !== 0) {
    console.error(`✗ ${app.name}: ${build.stderr.toString()}`)
    process.exit(1)
  }

  // El tarball se arma desde un staging dir para que adentro quede una carpeta
  // con nombre, y no un puñado de archivos sueltos que se desparraman al
  // desempaquetar en el cwd de alguien.
  const stage = join(OUT, `ia-flow-${app.name}-${version}`)
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, `${app.name}.js`), await Bun.file(js).arrayBuffer().then(Buffer.from))
  writeFileSync(join(stage, 'Dockerfile.example'), dockerfile(app))
  writeFileSync(join(stage, 'README.md'), readme(app))
  writeFileSync(join(stage, 'VERSION'), `${version}\n`)
  writeFileSync(join(stage, 'BUN_VERSION'), `${BUN_VERSION}\n`)

  const tar = Bun.spawnSync(
    ['tar', '-czf', `ia-flow-${app.name}-${version}.tar.gz`, `ia-flow-${app.name}-${version}`],
    { cwd: OUT },
  )
  if (tar.exitCode !== 0) {
    console.error(`✗ tar ${app.name}: ${tar.stderr.toString()}`)
    process.exit(1)
  }
  rmSync(stage, { recursive: true, force: true })

  for (const f of [`ia-flow-${app.name}.js`, `ia-flow-${app.name}-${version}.tar.gz`]) {
    const hash = new Bun.CryptoHasher('sha256')
    hash.update(new Uint8Array(await Bun.file(join(OUT, f)).arrayBuffer()))
    sums.push(`${hash.digest('hex')}  ${f}`)
  }

  const kb = Math.round(Bun.file(js).size / 1024)
  console.log(`✓ ia-flow-${app.name}  (${kb} KB de bundle + tarball)`)
}

writeFileSync(join(OUT, 'SHA256SUMS'), `${sums.join('\n')}\n`)
console.log(`\n→ dist/artifacts/  (v${version}, Bun ${BUN_VERSION})`)
