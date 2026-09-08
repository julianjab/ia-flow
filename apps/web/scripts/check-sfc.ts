/**
 * ¿Parsean todos los `.vue`?
 *
 * Parece redundante con `vue-tsc`, y no lo es: **vue-tsc saltea el archivo que
 * no puede parsear** en vez de fallar. Un `</div>` que cierra un `<label>` deja
 * el typecheck en verde, biome en verde y los tests en verde —si nadie monta
 * ese componente— y la pantalla explota recién al abrirla en el navegador, con
 * un "Invalid end tag" que no aparece en ningún CI.
 *
 * Pasó exactamente así: un reemplazo masivo de `<div class="field">` a
 * `<label class="ff-row">` cambió las aperturas y dejó un cierre sin par. Los
 * tres checks pasaron; `bun run dev` fue lo único que lo dijo.
 *
 * Esto corre el MISMO parser que usa Vite (`@vue/compiler-sfc`), así que lo que
 * pasa acá compila allá. Es rápido —parsear, no typechequear— y por eso puede
 * vivir dentro de `typecheck` sin que se note.
 */
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import { Glob } from 'bun'

const root = new URL('..', import.meta.url).pathname
let broken = 0

for await (const rel of new Glob('src/**/*.vue').scan(root)) {
  const file = `${root}${rel}`
  const { errors } = parse(readFileSync(file, 'utf8'), { filename: file })
  for (const e of errors) {
    broken++
    // `loc` viene del parser, así que el número de línea es el mismo que
    // mostraría Vite: se puede saltar directo ahí.
    const at = 'loc' in e && e.loc ? `:${e.loc.start.line}:${e.loc.start.column}` : ''
    console.error(`${rel}${at}  ${e.message}`)
  }
}

if (broken > 0) {
  console.error(`\n${broken} error(es) de parseo en SFCs — esas pantallas no cargan.`)
  process.exit(1)
}
console.log('SFC parse: ok')
