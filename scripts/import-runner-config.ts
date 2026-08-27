#!/usr/bin/env bun
// Replica en SQLite la config de un deploy del flavor `runner` (su
// `runner.yaml` + las carpetas `projects/<id>/{project,agents/,repos/}` que
// tenga al lado), para que ese pipeline se pueda ver y editar desde la UI de
// un server completo en vez de existir sólo como YAML de deploy.
//
//   bun run scripts/import-runner-config.ts deploys/subscriptions-pipeline/runner.yaml --dry-run
//   bun run scripts/import-runner-config.ts deploys/subscriptions-pipeline/runner.yaml
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
for (const p of projects) {
  add('project', p.id, projectRepo.get(p.id) ? 'update' : 'create')
}

// Repos --------------------------------------------------------------------
// `path` del YAML es el del contenedor. Con --repos-base se reescribe la parte
// después de `/repos/`; sin el flag se importa tal cual y el primer run avisa
// con un warn y lo corrige solo (en SQLite el upsert del engine sí persiste).
const rewritePath = (path?: string): string | undefined => {
  if (!path || !reposBase) return path
  const idx = path.indexOf('/repos/')
  return idx === -1 ? path : `${reposBase}${path.slice(idx + '/repos'.length)}`
}
const repos = cfg.repos.map((r) => ({ ...r, path: rewritePath(r.path) }))
for (const r of repos) {
  const exists = repoRepo.getByProject(r.name, r.projectId)
  add('repo', `${r.projectId}/${r.name}`, exists ? 'update' : 'create')
}

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

const existingAgents = new Map(agentRepo.inScope().map((a) => [a.id, a]))
const conflicts: { id: string; from: string | null; to: string | null }[] = []
const renames = new Map<string, string>()
// Modo `rename-existing`: el que se mueve es el agente que YA estaba, para que
// el del deploy entre con su id tal cual lo declara el YAML.
const existingRenames: { agent: AgentDefinition; to: string }[] = []

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
      renames.set(a.id, `${prefix}${a.id}`)
      add('agent', `${scope ?? 'global'}/${prefix}${a.id}`, 'create', `renombrado desde '${a.id}'`)
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
  for (const p of projects) {
    const { createdAt: _c, updatedAt: _u, archivedAt: _a, ...input } = p
    projectRepo.upsert(input)
  }
  for (const r of repos) repoRepo.upsert(r)
  for (const [scope, list] of byScope) {
    list.forEach((a, index) => {
      const id = renames.get(a.id) ?? a.id
      agentRepo.upsert({ ...a, id }, index, scope)
    })
  }
  const base = mcpRepo.list().length
  mcpToWrite.forEach((entry, index) => mcpRepo.upsert(entry, base + index))
})()

console.log('\n✅ Importado.\n')
