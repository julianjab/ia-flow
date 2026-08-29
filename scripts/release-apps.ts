// Qué apps se publican, y cómo se ve el `Dockerfile.example` de cada una.
//
// Vive aparte porque tiene DOS consumidores que no pueden divergir:
//
//   scripts/package-release.ts          → el Dockerfile.example de cada .tar.gz
//   scripts/write-dockerfile-examples.ts → el Dockerfile.example de cada app
//
// Antes había un solo generador (el de la release) y los ejemplos del árbol no
// existían. Escribirlos a mano habría creado una segunda fuente del mismo
// archivo: el pin de Bun, las env vars por flavor y el `--chown/--chmod` se
// habrían desincronizado en el primer cambio, y el del árbol —que es el que
// alguien lee al abrir la carpeta— sería el que envejece.

/** La versión de Bun con la que el bundle está probado. NO es cosmética: Bun
 *  1.4.x cambió el transform de decorators legacy y rompe `@memoize`
 *  (packages/shared/src/cache.ts), que está en el grafo de las tres apps. Un
 *  consumidor que use otra base se lleva ese bug sin ninguna señal, así que la
 *  versión viaja DENTRO del artefacto y no sólo en un README. */
export const BUN_VERSION = '1.1.30'

export const APPS = [
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
    // Dónde queda el ejemplo dentro del árbol, al lado del Dockerfile que
    // construye la MISMA app desde el código de acá. El par se lee junto: uno
    // baja el bundle publicado, el otro compila el working tree.
    examplePath: 'apps/server/Dockerfile.example',
  },
  {
    name: 'runner',
    entry: 'apps/server/src/entry/runner.ts',
    title: 'ia-flow — engine headless (flavor runner)',
    port: 3001,
    env: ['IA_FLOW_CONFIG_DIR=/state', 'IA_FLOW_DB_PATH=/state/ia-flow.sqlite', 'LOG_PLAIN=true'],
    needsGit: true,
    note: 'Su config entra por un runner.yaml montado en runtime; el path va\n# como argv[1] (default /app/config/runner.yaml).',
    examplePath: 'apps/server/Dockerfile.runner.example',
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
    examplePath: 'apps/ai-provider-gateway/Dockerfile.example',
  },
] as const

export type ReleaseApp = (typeof APPS)[number]

/** De dónde bajar los artefactos. Sale del entorno de Actions cuando corre en
 *  CI; el fallback es para correrlo a mano. Hardcodearlo haría que un fork —o
 *  un rename del repo— publique artefactos cuyo `Dockerfile.example` apunta a
 *  una URL que da 404. */
export function repoSlug(): string {
  return Bun.env.GITHUB_REPOSITORY ?? 'julianjab/ia-flow'
}

/**
 * El `Dockerfile.example` de una app.
 *
 * `version` decide la FORMA, no sólo un string:
 *
 * - Un número (el del `.tar.gz` de una release) hornea la URL: ese artefacto ES
 *   esa versión, y un ejemplo que hay que parametrizar para correr sería peor.
 * - `null` (el ejemplo del árbol) emite un `ARG IA_FLOW_VERSION` sin default.
 *   Hornear la versión ahí obligaría a regenerar el archivo en el mismo commit
 *   en que release-please bumpea `version.txt` —o `--check` rompería su propio
 *   Release PR— y un ejemplo que apunta a una release vieja es justamente el
 *   tipo de receta desactualizada que este generador existe para evitar.
 */
export function dockerfile(app: ReleaseApp, version: string | null, repo = repoSlug()): string {
  const ref = version ? `v${version}` : '${IA_FLOW_VERSION}'
  const url = `https://github.com/${repo}/releases/download/${ref}/ia-flow-${app.name}.js`
  return `# ${app.title}${version ? ` — v${version}` : ''}
#
# Este Dockerfile NO necesita el repo de ia-flow: baja el bundle publicado y lo
# corre. Copiá esto donde quieras y cambiá la base si te sirve otra.
#${
    version
      ? ''
      : `
# Qué release bajar entra por build-arg, y va SIN default para que olvidarlo
# rompa el build en el ADD en vez de desplegar una versión que nadie pidió:
#
#     podman build --build-arg IA_FLOW_VERSION=v0.2.0 -f Dockerfile.example .
#`
  }
# ⚠️  La versión de Bun NO es libre. El bundle está construido y probado con
#     ${BUN_VERSION}; Bun 1.4.x rompe \`@memoize\`, que está en el grafo de esta
#     app, y lo hace SIN ningún error visible. Si subís esta base, verificá
#     antes que el issue #80 del repo esté cerrado.
FROM oven/bun:${BUN_VERSION}-slim
${version ? '' : '\nARG IA_FLOW_VERSION'}
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

export function readme(app: ReleaseApp, version: string, repo = repoSlug()): string {
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
    ADD --chmod=644 https://github.com/${repo}/releases/download/v${version}/ia-flow-${app.name}.js /app/${app.name}.js
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
