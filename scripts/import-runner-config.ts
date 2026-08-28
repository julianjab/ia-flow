#!/usr/bin/env bun
// Replica en SQLite la config de un deploy del flavor `runner` (su
// `runner.yaml` + las carpetas `projects/<id>/{project,agents/,repos/}` que
// tenga al lado), para que ese pipeline se pueda ver y editar desde la UI de
// un server completo en vez de existir sólo como YAML de deploy.
//
//   bun run scripts/import-runner-config.ts <deploy>/runner.yaml --dry-run
//   bun run scripts/import-runner-config.ts <deploy>/runner.yaml
//
// Este repo ya no tiene deploys del runner: el roster vivo es el de
// `ai-development-flow` en claw-agents. Apuntá el script a ese `config/`.
//
// Flags:
//   --dry-run              imprime el plan y no escribe nada
//   --db=<path>            SQLite destino (default: IA_FLOW_DB_PATH / ~/.config/ia-flow)
//   --repos-base=<dir>     reescribe el prefijo `<algo>/repos` de `path` de cada
//                          repo a este directorio — los paths del YAML son los
//                          del contenedor (/state/repos/...) y no existen acá
//   --on-conflict=<modo>   qué hacer con un id de agente que YA existe en otro
//                          scope: abort (default) | rename | rename-existing |
//                          overwrite
//   --prefix=<str>         prefijo para --on-conflict=rename (default: `subs-`)
//   --existing-suffix=<s>  sufijo para --on-conflict=rename-existing, que mueve
//                          de id al agente que YA estaba y le deja el suyo al
//                          del deploy (default: `-global`)
//
// Por qué el conflicto merece un flag y no un default silencioso: `agents.id`
// es PRIMARY KEY global (el UPSERT es `ON CONFLICT(id)`), no `(id, project_id)`.
// Importar un agente `reviewer` de un deploy sobre una base que ya tiene un
// `reviewer` GLOBAL no crea una fila nueva: pisa el prompt del que estaba y
// además lo saca del scope global metiéndolo en este proyecto. Eso es
// destructivo y no se deshace, así que por default el script se planta.
//
// Qué NO importa, a propósito:
//   - el bloque `settings` del runner.yaml (daemonMode, logLevel, instanceId,
//     workspace): son env vars del proceso de ESE deploy, no config de
//     proyecto. Volcarlas acá le cambiaría el comportamiento al server local.
//   - statuses / system prompts / prompts: el deploy no los declara — ya viven
//     en SQLite y nadie los toca.
//
// Instancia repos concretos (lo que el CLAUDE.md reserva para
// composition/container.ts). Es deliberado: esto es un script de ops fuera del
// hexágono, y el container se evalúa entero al importarse —arrastraría
// providers, gateways y el daemon— para usar cuatro repositorios.
import { basename } from 'node:path'
import type { AgentDefinition, McpCatalogEntry, Project } from '@ia-flow/shared'

// ─── Args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')
const has = (name: string): boolean => argv.includes(`--${name}`)

const configPath = argv.find((a) => !a.startsWith('--'))
if (!configPath) {
  console.error('Uso: bun run scripts/import-runner-config.ts <runner.yaml> [--dry-run]')
  process.exit(1)
}

const dryRun = has('dry-run')
const reposBase = flag('repos-base')?.replace(/\/$/, '')
const onConflict = flag('on-conflict') ?? 'abort'
const prefix = flag('prefix') ?? 'subs-'
const existingSuffix = flag('existing-suffix') ?? '-global'
const CONFLICT_MODES = ['abort', 'rename', 'rename-existing', 'overwrite']
if (!CONFLICT_MODES.includes(onConflict)) {
  console.error(`--on-conflict inválido: '${onConflict}' (${CONFLICT_MODES.join(' | ')})`)
  process.exit(1)
}
const dbFlag = flag('db')
if (dbFlag) process.env.IA_FLOW_DB_PATH = dbFlag

// Después de fijar IA_FLOW_DB_PATH: `database.ts` lo lee al evaluarse.
const { loadRunnerConfig } = await import('../apps/server/src/runner/config.js')
const {
  getDb,
  SqliteAgentRepository,
  SqliteMcpCatalogRepository,
  SqliteProjectRepository,
  SqliteRepoRepository,
} = await import('../apps/server/src/infrastructure/db/index.js')

const cfg = loadRunnerConfig(configPath)
const db = getDb()
const projectRepo = new SqliteProjectRepository(db)
const repoRepo = new SqliteRepoRepository(db)
const agentRepo = new SqliteAgentRepository(db)
const mcpRepo = new SqliteMcpCatalogRepository(db)

// ─── Plan ─────────────────────────────────────────────────────────────────

type Action = 'create' | 'update' | 'skip'
const plan: { kind: string; id: string; action: Action; note?: string }[] = []
const add = (kind: string, id: string, action: Action, note?: string) =>
  plan.push({ kind, id, action, note })

// Proyectos ----------------------------------------------------------------
const projects: Project[] = cfg.projects
// `upsert` reemplaza la fila entera, y `project.yaml` declara sólo un subconjunto
// de `settings` (systemPrompts, Slack). Sobre un proyecto que ya existe eso
// borraría lo que se configuró desde la UI y el YAML no menciona
// (maxConcurrentDispatches, config de providers, polling…). Por eso se mergea:
// gana el YAML clave por clave, y lo que no nombra sobrevive.
const projectInputs = projects.map((p) => {
  const prev = projectRepo.get(p.id)
  const kept = Object.keys(prev?.settings ?? {}).filter((k) => !(k in (p.settings ?? {})))
  add(
    'project',
    p.id,
    prev ? 'update' : 'create',
    kept.length ? `se conservan ${kept.length} claves de settings: ${kept.join(', ')}` : undefined,
  )
  return { ...p, settings: { ...prev?.settings, ...p.settings } }
})

// Repos --------------------------------------------------------------------
// `path` del YAML es el del contenedor. Con --repos-base se reescribe la parte
// después de `/repos/`; sin el flag se importa tal cual y el primer run avisa
// con un warn y lo corrige solo (en SQLite el upsert del engine sí persiste).
const rewritePath = (path?: string): string | undefined => {
  if (!path || !reposBase) return path
  const idx = path.indexOf('/repos/')
  return idx === -1 ? path : `${reposBase}${path.slice(idx + '/repos'.length)}`
}
// Mismo criterio que con `settings` del proyecto: el upsert reemplaza la fila,
// así que un repo que ya está no pierde `description` ni sus campos de Slack
// porque el YAML del deploy no los declare.
const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

const repos = cfg.repos.map((r) => {
  const prev = repoRepo.getByProject(r.name, r.projectId)
  const merged = { ...prev, ...defined({ ...r, path: rewritePath(r.path) }) }
  const kept = prev
    ? Object.keys(prev).filter(
        (k) => (prev as Record<string, unknown>)[k] !== undefined && !(k in defined(r)),
      )
    : []
  add(
    'repo',
    `${r.projectId}/${r.name}`,
    prev ? 'update' : 'create',
    kept.length ? `se conservan: ${kept.join(', ')}` : undefined,
  )
  return merged
})

// Agentes ------------------------------------------------------------------
// El orden espeja YamlAgentRepository: `position` declarada, y si no el orden
// de lectura de los archivos (alfabético, de ahí los prefijos numéricos).
const ordered = cfg.agents
  .map((a, index) => ({ a, key: a.position ?? index }))
  .sort((x, y) => x.key - y.key)
  .map(({ a }) => a)

const byScope = new Map<string | null, AgentDefinition[]>()
for (const a of ordered) {
  const scope = a.projectId ?? null
  const list = byScope.get(scope) ?? []
  list.push(a)
  byScope.set(scope, list)
}

// Dos proyectos del MISMO deploy pueden traer un agente con el mismo id (cada
// roster vive en su carpeta y nada los obliga a ser únicos entre sí). En YAML
// conviven —el índice es `(id, projectId)`—, pero acá `agents.id` es PRIMARY
// KEY global: el segundo upsert se llevaría puesto al primero y dejaría una
// sola fila, con el project_id del último. No hay flag que arregle esto: los
// dos son entrantes, así que se aborta nombrando el id y sus scopes.
const seen = new Map<string, (string | null)[]>()
for (const a of cfg.agents) {
  const scopes = seen.get(a.id) ?? []
  scopes.push(a.projectId ?? null)
  seen.set(a.id, scopes)
}
const dupes = [...seen].filter(([, scopes]) => scopes.length > 1)
if (dupes.length) {
  console.error('\n❌ El propio config declara ids de agente repetidos:')
  for (const [id, scopes] of dupes) {
    console.error(`   '${id}' en ${scopes.map((s) => s ?? 'global').join(', ')}`)
  }
  console.error(
    '\n   `agents.id` es PRIMARY KEY global en SQLite: sólo sobreviviría el último.\n' +
      '   Renombralos en el YAML antes de importar.\n',
  )
  process.exit(1)
}

const existingAgents = new Map(agentRepo.inScope().map((a) => [a.id, a]))
const conflicts: { id: string; from: string | null; to: string | null }[] = []
const renames = new Map<string, string>()
// Modo `rename-existing`: el que se mueve es el agente que YA estaba, para que
// el del deploy entre con su id tal cual lo declara el YAML.
const existingRenames: { agent: AgentDefinition; to: string }[] = []
// El id derivado por `rename`, con el scope donde va a aterrizar — hace falta
// el scope para distinguir "pisa a otro agente" de "es el mismo, reimportado".
const renameTargets: { to: string; scope: string | null }[] = []

for (const [scope, list] of byScope) {
  for (const a of list) {
    const prev = existingAgents.get(a.id)
    if (!prev) {
      add('agent', `${scope ?? 'global'}/${a.id}`, 'create')
      continue
    }
    const prevScope = prev.projectId ?? null
    if (prevScope === scope) {
      add('agent', `${scope ?? 'global'}/${a.id}`, 'update')
      continue
    }
    conflicts.push({ id: a.id, from: prevScope, to: scope })
    if (onConflict === 'rename') {
      const to = `${prefix}${a.id}`
      renames.set(a.id, to)
      renameTargets.push({ to, scope })
      const landed = existingAgents.get(to)
      add(
        'agent',
        `${scope ?? 'global'}/${to}`,
        landed && (landed.projectId ?? null) === scope ? 'update' : 'create',
        `renombrado desde '${a.id}'`,
      )
    } else if (onConflict === 'rename-existing') {
      existingRenames.push({ agent: prev, to: `${a.id}${existingSuffix}` })
      add(
        'agent',
        `${prevScope ?? 'global'}/${a.id}${existingSuffix}`,
        'update',
        `el TUYO, movido desde '${a.id}' para dejarle el id al deploy`,
      )
      add('agent', `${scope ?? 'global'}/${a.id}`, 'create')
    } else if (onConflict === 'overwrite') {
      add(
        'agent',
        `${scope ?? 'global'}/${a.id}`,
        'update',
        `PISA el agente de '${prevScope ?? 'global'}'`,
      )
    }
  }
}

// MCP ----------------------------------------------------------------------
// Se saltea lo que ya existe con el mismo contenido: el catálogo es global y
// pisarlo desde un deploy es el mismo riesgo que con los agentes, sin la
// contraparte de que alguien lo esté pidiendo.
const mcp: McpCatalogEntry[] = cfg.mcp ?? []
const mcpToWrite: McpCatalogEntry[] = []
for (const entry of mcp) {
  const prev = mcpRepo.get(entry.id)
  if (!prev) {
    mcpToWrite.push(entry)
    add('mcp', entry.id, 'create')
  } else if (JSON.stringify(prev.config) === JSON.stringify(entry.config)) {
    add('mcp', entry.id, 'skip', 'ya existe, idéntico')
  } else {
    add('mcp', entry.id, 'skip', 'ya existe con OTRA config — no se pisa (editalo en la UI)')
  }
}

// ─── Report + apply ───────────────────────────────────────────────────────

console.log(
  `\n📦 ${basename(configPath)} → ${process.env.IA_FLOW_DB_PATH ?? '~/.config/ia-flow'}\n`,
)
for (const p of plan) {
  const icon = p.action === 'create' ? '＋' : p.action === 'update' ? '↻' : '–'
  console.log(`  ${icon} ${p.kind.padEnd(8)} ${p.id}${p.note ? `   (${p.note})` : ''}`)
}

// Un rename que aterriza sobre un id ocupado sería la misma escritura
// destructiva que `abort` existe para evitar — y es el caso probable al correr
// el script dos veces seguidas con el mismo modo.
// Los ids FINALES (después de aplicar `--prefix`) también tienen que ser
// únicos entre sí: un `--prefix=subs-` sobre un `reviewer` produce
// `subs-reviewer`, que puede ser el id de OTRO agente del mismo YAML. Ahí los
// dos upserts escribirían la misma fila y ganaría el último, sin aviso — y el
// guard de duplicados de arriba no lo ve, porque mira los ids crudos.
const finalIds = new Map<string, number>()
for (const [, list] of byScope) {
  for (const a of list) {
    const id = renames.get(a.id) ?? a.id
    finalIds.set(id, (finalIds.get(id) ?? 0) + 1)
  }
}
const finalDupes = [...finalIds].filter(([, n]) => n > 1).map(([id]) => id)
if (finalDupes.length) {
  console.error(
    `\n❌ Después de aplicar --prefix quedan ids repetidos: ${finalDupes.join(', ')}.\n` +
      '   Elegí otro --prefix, o renombrá el agente en el YAML.\n',
  )
  process.exit(1)
}

const taken = new Set([...existingAgents.keys(), ...cfg.agents.map((a) => a.id)])
const collisions: string[] = []
for (const { to, scope } of renameTargets) {
  // El id derivado ya existe EN EL MISMO scope al que apunta ⇒ es el que dejó
  // un run anterior de este mismo comando: reimportarlo es un update, no una
  // escritura destructiva. Sin esta excepción, sincronizar cambios del YAML de
  // un deploy ya importado era imposible en modo `rename`.
  const prev = existingAgents.get(to)
  if (prev && (prev.projectId ?? null) === scope) continue
  if (taken.has(to)) collisions.push(to)
}
for (const { to } of existingRenames) if (taken.has(to)) collisions.push(to)
if (collisions.length) {
  console.error(
    `\n❌ El rename apunta a ids que YA existen: ${collisions.join(', ')}.\n` +
      '   Pisarlos sería la misma escritura destructiva que este script evita.\n' +
      `   Elegí otro --prefix / --existing-suffix, o borrá esos agentes primero.\n`,
  )
  process.exit(1)
}

if (conflicts.length && onConflict === 'abort') {
  console.error('\n❌ Ids de agente que ya existen en otro scope:')
  for (const c of conflicts) {
    console.error(`   '${c.id}': está en ${c.from ?? 'global'}, el deploy lo trae en ${c.to}`)
  }
  console.error(
    '\n   `agents.id` es PRIMARY KEY global: importar así pisaría el agente que está\n' +
      '   y lo movería de scope. Elegí:\n' +
      `     --on-conflict=rename           (el del deploy entra como '${prefix}<id>')\n` +
      `     --on-conflict=rename-existing  (el TUYO pasa a '<id>${existingSuffix}')\n` +
      '     --on-conflict=overwrite        (pisa el original — irreversible)\n',
  )
  process.exit(1)
}

if (dryRun) {
  console.log('\n🔍 --dry-run: no se escribió nada.\n')
  process.exit(0)
}

db.transaction(() => {
  // Primero los renames de lo que YA estaba: liberan el id antes de que el
  // upsert del deploy lo reclame. La posición se recalcula dentro de su scope
  // en vez de confiar en `agent.position` de la fila leída, que es el número
  // crudo de la columna y no necesariamente el índice entre sus hermanos.
  for (const { agent, to } of existingRenames) {
    const scope = agent.projectId ?? null
    const index = agentRepo.inScope(scope).findIndex((x) => x.id === agent.id)
    agentRepo.upsert({ ...agent, id: to }, index === -1 ? 0 : index, scope)
    agentRepo.deleteById(agent.id)
  }
  for (const p of projectInputs) {
    const { createdAt: _c, updatedAt: _u, archivedAt: _a, ...input } = p
    projectRepo.upsert(input)
  }
  for (const r of repos) repoRepo.upsert(r)
  // `position` es lo que desempata en `selectAgent` ("el primero por
  // position"), así que los importados van DESPUÉS de los que ya estaban en
  // ese scope, no desde 0 — dos filas en la misma posición dejan el orden del
  // pipeline a merced del `ORDER BY position` con empate, que es arbitrario.
  // El `setPositions` final normaliza el scope entero a 0..N-1.
  for (const [scope, list] of byScope) {
    const before = agentRepo.inScope(scope).map((a) => a.id)
    const importedIds = list.map((a) => renames.get(a.id) ?? a.id)
    list.forEach((a, index) => {
      agentRepo.upsert({ ...a, id: importedIds[index] as string }, before.length + index, scope)
    })
    agentRepo.setPositions(
      [...before.filter((id) => !importedIds.includes(id)), ...importedIds],
      scope,
    )
  }
  const base = mcpRepo.list().length
  mcpToWrite.forEach((entry, index) => mcpRepo.upsert(entry, base + index))
})()

console.log('\n✅ Importado.\n')
