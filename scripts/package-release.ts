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

// Las apps y el generador del Dockerfile.example viven aparte porque los
// comparte `write-dockerfile-examples.ts`, que escribe el mismo archivo dentro
// del árbol. Ver el encabezado de ese módulo.
import { APPS, BUN_VERSION, dockerfile, readme, repoSlug } from './release-apps'

const version = (process.argv[2] ?? Bun.env.VERSION ?? '0.0.0-dev').replace(/^v/, '')
const REPO = repoSlug()
const OUT = join(import.meta.dir, '..', 'dist', 'artifacts')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

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
  writeFileSync(join(stage, 'Dockerfile.example'), dockerfile(app, version, REPO))
  writeFileSync(join(stage, 'README.md'), readme(app, version, REPO))
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
