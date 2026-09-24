/**
 * Demo end-to-end del engine: EventBus → Engine → Pipeline → Agent → Provider.
 *
 * Usa un `EchoProvider` — NO es el `AnthropicApiProvider` real de v1 (eso
 * sigue pendiente, ver la sesión de research sobre por qué envolverlo no es
 * un wrapper delgado). Este demo prueba que el CABLEADO funciona con las
 * piezas que ya están implementadas de verdad: no hay nada acá que no exista
 * ya en `src/`.
 *
 * `Project`/`Repo`/`Agent`/`Pipeline` se resuelven SIEMPRE contra las
 * `EngineSources` que recibe el `Engine` por constructor, nunca cacheadas.
 * Acá las fuentes son `Map` de juguete; en `apps/server` son adapters que
 * pegan contra los repos reales de v1. Es EL mismo mecanismo en los dos
 * casos, y es también cómo un test mockearía esto — no hay estado estático
 * ni un modo especial "de test" en las clases.
 *
 * Correr: `bun run demo` (desde packages/engine-v2).
 */

import { Project, type ProjectRow } from '../src/domain/Project.js'
import { Repo, type RepoRow } from '../src/domain/Repo.js'
import type { AgentRunContext, ProviderRunOutput } from '../src/engine/Agent.js'
import { Agent, type AgentRow, ERROR_EXIT, SUCCESS_EXIT } from '../src/engine/Agent.js'
import { Engine } from '../src/engine/Engine.js'
import { ExecutionLog } from '../src/engine/ExecutionLog.js'
import { Provider } from '../src/engine/Provider.js'
import { DomainEvent } from '../src/events/DomainEvent.js'
import { EventBus } from '../src/events/EventBus.js'
import { AgentAction } from '../src/pipeline/actions/AgentAction.js'
import { Pipeline } from '../src/pipeline/Pipeline.js'

/** El provider más simple posible: cierra todo run como éxito, sin correr
 *  ningún modelo de verdad. Sirve para probar el loop completo del engine
 *  sin necesitar credenciales ni el ToolExecutionPort que un provider real
 *  (anthropic-api) necesitaría. Recibe el prompt YA renderizado — nunca ve
 *  un `{{...}}` sin resolver, eso lo resuelve Agent.renderPrompt antes de
 *  llamarlo (ver el prompt del agente más abajo). */
class EchoProvider extends Provider {
  async run(input: AgentRunContext): Promise<ProviderRunOutput> {
    console.log(`  [EchoProvider] corriendo agente "${input.agentId}" — prompt: "${input.prompt}"`)
    return { outcome: SUCCESS_EXIT, summary: 'echo ok' }
  }
}

function fromRow<R, T>(row: R | undefined, map: (row: R) => T): T | undefined {
  return row == null ? undefined : map(row)
}

// --- fuentes de juguete: un Map en memoria, igual de válido que cualquier
// otro adapter — Project/Repo/Agent no saben ni les importa qué hay detrás. ---
const projectRows = new Map<string, ProjectRow>([['demo-project', { id: 'demo-project' }]])

const repoRows = new Map<string, RepoRow>([
  [
    'demo-project:demo-repo',
    { name: 'demo-repo', projectId: 'demo-project', path: '/tmp/demo-repo' },
  ],
])

const agentRows = new Map<string, AgentRow>([
  [
    'echo-agent',
    {
      id: 'echo-agent',
      provider: 'echo-provider',
      // {{title}} viene del payload del evento, {{variables.tone}} de la
      // config del propio agente — las dos fuentes que Agent.renderPrompt
      // combina antes de que el Provider vea una sola letra del prompt.
      prompt: 'Resolvé el issue "{{title}}" con tono {{variables.tone}}.',
      variables: { tone: 'profesional' },
      exits: { [SUCCESS_EXIT]: 'closed', [ERROR_EXIT]: 'failed' },
    },
  ],
])

Provider.register(new EchoProvider({ id: 'echo-provider', kind: 'sync' }))

AgentAction.register(
  'run-echo-agent',
  new AgentAction({ id: 'run-echo-agent', agentId: 'echo-agent' }),
)
const pipeline = new Pipeline({
  id: 'demo-pipeline',
  on: ['issue.observed'],
  do: [AgentAction.resolve('run-echo-agent') as AgentAction],
})

const bus = new EventBus()
const engine = new Engine(bus, {
  pipelines: { list: async () => [pipeline] },
  projects: { get: (id) => fromRow(projectRows.get(id), Project.fromRow) },
  repos: {
    get: (projectId, name) => fromRow(repoRows.get(`${projectId}:${name}`), Repo.fromRow),
  },
  agents: { get: (id) => fromRow(agentRows.get(id), Agent.fromRow) },
})
engine.start()

console.log('Publicando issue.observed…')
bus.publish(
  new DomainEvent(
    'issue.observed',
    { id: 'demo-1', title: 'Issue de prueba' },
    { scope: { projectId: 'demo-project', repos: ['demo-repo'], issueId: 'demo-1' } },
  ),
)

// El bus es fire-and-forget (Engine.dispatch corre async sin await del lado
// del publish) — le damos una vuelta de microtask para que el pipeline
// termine antes de leer el resultado.
await new Promise((resolve) => setTimeout(resolve, 50))

const log = ExecutionLog.byTask('demo-1')
console.log('\nExecutionLog para demo-1:')
console.log(
  log.map((entry) => ({ agentId: entry.agentId, outcome: entry.outcome, exit: entry.exit })),
)

if (log.length === 0 || log[0]?.status !== 'completed') {
  console.error('\n❌ el demo no completó ningún run — revisar el pipeline/wiring')
  process.exit(1)
}
console.log('\n✅ engine-v2 corrió punta a punta: evento → pipeline → agente → provider → log')
