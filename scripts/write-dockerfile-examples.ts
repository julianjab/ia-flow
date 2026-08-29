#!/usr/bin/env bun
// Escribe el `Dockerfile.example` de cada app, al lado del `Dockerfile` que
// construye esa misma app desde el código de acá.
//
//   bun run scripts/write-dockerfile-examples.ts           escribe
//   bun run scripts/write-dockerfile-examples.ts --check   falla si difieren
//
// Los dos archivos de una app son el par que hace entendible la carpeta:
//
//   Dockerfile          compila el WORKING TREE (contexto = raíz del repo)
//   Dockerfile.example  baja el BUNDLE PUBLICADO (no necesita el repo)
//
// Salen del mismo generador que los que van dentro de cada `.tar.gz` de la
// release (`scripts/release-apps.ts`), así que no pueden divergir. `--check`
// corre en `bun run check`: sin eso, el ejemplo del árbol —que es el que
// alguien lee al abrir la carpeta— envejecería en silencio cada vez que
// cambiara el pin de Bun o una env var, y sería el peor lugar donde tener una
// receta desactualizada.
//
// Estos ejemplos NO llevan la versión horneada: la piden por
// `--build-arg IA_FLOW_VERSION`. Si la llevaran, el Release PR de
// release-please —que bumpea `version.txt`— dejaría los tres archivos
// desactualizados en su propio commit y `--check` rompería el PR que publica la
// release. Los del `.tar.gz` sí la hornean, porque ese artefacto ES esa
// versión. Ver `dockerfile()` en release-apps.ts.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APPS, dockerfile } from './release-apps'

const ROOT = join(import.meta.dir, '..')
const check = process.argv.includes('--check')

const stale: string[] = []

for (const app of APPS) {
  const path = join(ROOT, app.examplePath)
  const want = dockerfile(app, null)

  if (check) {
    // Un ejemplo que todavía no existe cuenta como desactualizado: el mensaje
    // es el mismo y la acción también.
    let have: string | null = null
    try {
      have = readFileSync(path, 'utf8')
    } catch {
      have = null
    }
    if (have !== want) stale.push(app.examplePath)
    continue
  }

  writeFileSync(path, want)
  console.log(`✓ ${app.examplePath}`)
}

if (check) {
  if (stale.length > 0) {
    console.error(
      `✗ Dockerfile.example desactualizado:\n${stale.map((s) => `    ${s}`).join('\n')}`,
    )
    console.error('\n  Corré: bun run docker:examples')
    process.exit(1)
  }
  console.log('✓ Dockerfile.example al día')
} else {
  console.log(`\n→ ${APPS.length} ejemplos escritos`)
}
