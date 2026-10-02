#!/usr/bin/env bun
// Regenera las referencias del plugin `ia-flow-kit` desde las fuentes de verdad del repo.
//
//   bun run plugin:sync           escribe las copias
//   bun run plugin:sync --check   falla si alguna copia está desactualizada (para CI / check)
//
// El plugin se instala global y trabaja en OTRO repo (p. ej. claw-agents), donde no hay un
// checkout de ia-flow: por eso las fuentes viajan dentro del plugin como copias generadas. No se
// editan a mano: se cambia la fuente y se corre este script.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const PLUGIN = join(ROOT, 'plugins', 'ia-flow-kit')
const check = process.argv.includes('--check')

const BANNER = (src: string) =>
  `<!-- GENERADO por scripts/sync-plugin-docs.ts desde ${src}. No editar: cambiá la fuente y corré \`bun run plugin:sync\`. -->\n\n`

const SKILL_NOTE = `> Instalado como plugin: las fuentes de verdad que cita este skill vienen copiadas en
> \`\${CLAUDE_PLUGIN_ROOT}/references/engine/\` (core.md, definitions.md, runner-readme.md,
> schema.ts, RunnerConfig.ts, defineAction.ts, actions-catalog.md). Con un checkout de ia-flow
> (\`$IA_FLOW_REPO\`), las rutas originales mandan sobre las copias.

`

/** Los `.ts` (sin tests) bajo una carpeta, relativos a la raíz. */
function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = join(dir, entry.name)
    if (entry.isDirectory())
      return ['tests', 'node_modules'].includes(entry.name) ? [] : sourceFiles(rel)
    return rel.endsWith('.ts') && !rel.endsWith('.test.ts') ? [rel] : []
  })
}

/** Los ids de action/tool que declara el código, por regex: un índice, no la verdad. */
function actionsCatalog(): string {
  const dirs = [
    'apps/runner-v2/src/actions/builtin',
    'packages/github/tools/src',
    'packages/slack/tools/src',
    'packages/local/fs/src',
    'packages/local/shell/src',
    'packages/local/workspace/src',
  ]
  const rows: string[] = []
  for (const rel of dirs.filter((dir) => existsSync(join(ROOT, dir))).flatMap(sourceFiles)) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    const ids = new Set(
      [...text.matchAll(/\b(?:readonly )?id(?: =|:) '([a-z][a-z0-9_]+)'/g)].map((m) => m[1]),
    )
    for (const id of ids) rows.push(`| \`${id}\` | \`${rel}\` |`)
  }
  rows.sort()
  return `${BANNER('el código de apps/runner-v2/src/actions/builtin y packages/*/tools')}# Catálogo de actions y tools

Índice por regex de los ids que declara el código (puede omitir alguno construido dinámicamente):
confirmá en el archivo antes de nombrar uno. Las actions propias de un deploy viven en su
\`actions/*.ts\` y no aparecen acá.

| id | archivo |
| --- | --- |
${rows.join('\n')}
`
}

type Out = { path: string; content: string }
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const copy = (src: string, dest: string, banner = true): Out => ({
  path: join(PLUGIN, dest),
  content: (banner ? BANNER(src) : '') + read(src),
})

const outputs: Out[] = [
  copy('packages/agent-engine/core/CLAUDE.md', 'references/engine/core.md'),
  copy('packages/agent-engine/definitions/CLAUDE.md', 'references/engine/definitions.md'),
  copy('apps/runner-v2/README.md', 'references/engine/runner-readme.md'),
  copy('packages/agent-engine/definitions/src/schema.ts', 'references/engine/schema.ts', false),
  copy('apps/runner-v2/src/config/RunnerConfig.ts', 'references/engine/RunnerConfig.ts', false),
  copy('apps/runner-v2/src/config/boardConfig.ts', 'references/engine/boardConfig.ts', false),
  copy('apps/runner-v2/src/actions/defineAction.ts', 'references/engine/defineAction.ts', false),
  { path: join(PLUGIN, 'references/engine/actions-catalog.md'), content: actionsCatalog() },
]

// El skill de autoría del repo es la fuente; el plugin lleva una copia con la nota de instalación.
const SKILL_SRC = '.claude/skills/ia-flow-agent-authoring'
const skillMd = read(`${SKILL_SRC}/SKILL.md`)
const fm = skillMd.match(/^---\n[\s\S]*?\n---\n/)
if (!fm) throw new Error(`${SKILL_SRC}/SKILL.md sin frontmatter`)
outputs.push({
  path: join(PLUGIN, 'skills/ia-flow-agent-authoring/SKILL.md'),
  content: `${fm[0]}\n${BANNER(`${SKILL_SRC}/SKILL.md`)}${SKILL_NOTE}${skillMd.slice(fm[0].length).replace(/^\n/, '')}`,
})
for (const file of readdirSync(join(ROOT, SKILL_SRC, 'references'))) {
  outputs.push(
    copy(`${SKILL_SRC}/references/${file}`, `skills/ia-flow-agent-authoring/references/${file}`),
  )
}

let stale = 0
for (const { path, content } of outputs) {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  if (current === content) continue
  stale++
  if (check) console.error(`desactualizado: ${relative(ROOT, path)}`)
  else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    console.log(`escrito: ${relative(ROOT, path)}`)
  }
}
if (check && stale > 0) {
  console.error('\ncorré `bun run plugin:sync` y commiteá el resultado')
  process.exit(1)
}
console.log(check ? 'plugin: referencias al día' : `plugin: ${stale} archivo(s) actualizados`)
