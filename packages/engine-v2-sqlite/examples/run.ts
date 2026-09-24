/**
 * Demo de round-trip: registrar instancias en memoria → `toRow()` → guardar
 * en sqlite → RESETEAR los catálogos (simula un proceso nuevo) → releer con
 * `fromRow()` → correr el engine igual que el demo de `packages/engine-v2`,
 * pero con la config viniendo de disco, no de literales en el código.
 *
 * Correr: `bun run demo` (desde packages/engine-v2-sqlite).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Agent,
  AgentAction,
  DomainEvent,
  ERROR_EXIT,
  Engine,
  EventBus,
  ExecutionLog,
  Pipeline,
  Project,
  Provider,
  Repo,
  SUCCESS_EXIT,
  type AgentRunContext,
  type ProviderRunOutput,
} from '@ia-flow/engine-v2'
import { EngineV2Sqlite } from '../src/EngineV2Sqlite.js'

class EchoProvider extends Provider {
  async run(input: AgentRunContext): Promise<ProviderRunOutput> {
    console.log(`  [EchoProvider] corriendo agente "${input.agentId}" — prompt: "${input.prompt}"`)
    return { outcome: SUCCESS_EXIT, summary: 'echo ok' }
  }
}

const dir = mkdtempSync(join(tmpdir(), 'engine-v2-sqlite-demo-'))
const dbPath = join(dir, 'demo.sqlite')

console.log(`Guardando config en ${dbPath}\n`)

// --- "Proceso 1": arma la config en memoria y la persiste ---
Project.register(new Project({ id: 'demo-project' }))
Repo.register(new Repo({ name: 'demo-repo', projectId: 'demo-project', path: '/tmp/demo-repo' }))
Agent.register(
  new Agent({
    id: 'echo-agent',
    provider: 'echo-provider',
    prompt: 'Resolvé el issue "{{title}}" con tono {{variables.tone}}.',
    variables: { tone: 'profesional' },
    exits: { [SUCCESS_EXIT]: 'closed', [ERROR_EXIT]: 'failed' },
  }),
)
AgentAction.register('run-echo-agent', new AgentAction({ id: 'run-echo-agent', agentId: 'echo-agent' }))
const pipeline = new Pipeline({
  id: 'demo-pipeline',
  on: ['issue.observed'],
  do: [AgentAction.resolve('run-echo-agent') as AgentAction],
})

const store = EngineV2Sqlite.open(dbPath)
store.saveAll([pipeline])
store.close()

// --- "Proceso 2": arranca en frío, sólo lee de sqlite ---
Project.reset()
Repo.reset()
Agent.reset()
Provider.reset()
AgentAction.reset()

Provider.register(new EchoProvider({ id: 'echo-provider', kind: 'sync' }))

const reopened = EngineV2Sqlite.open(dbPath)
reopened.hydrateCatalogs()
const pipelines = reopened.loadPipelines()

const bus = new EventBus()
const engine = new Engine(bus)
for (const p of pipelines) engine.register(p)
engine.start()

console.log('Publicando issue.observed (con la config recargada de sqlite)…')
bus.publish(
  new DomainEvent(
    'issue.observed',
    { id: 'demo-1', title: 'Issue de prueba' },
    { scope: { projectId: 'demo-project', repos: ['demo-repo'], issueId: 'demo-1' } },
  ),
)

await new Promise((resolve) => setTimeout(resolve, 50))

const log = ExecutionLog.byTask('demo-1')
console.log('\nExecutionLog para demo-1:')
console.log(log.map((entry) => ({ agentId: entry.agentId, outcome: entry.outcome, exit: entry.exit })))

reopened.close()
rmSync(dir, { recursive: true, force: true })

if (log.length === 0 || log[0]?.status !== 'completed') {
  console.error('\n❌ el round-trip por sqlite no completó ningún run')
  process.exit(1)
}
console.log('\n✅ config guardada en sqlite, releída en un catálogo en blanco, y el engine corrió igual')
