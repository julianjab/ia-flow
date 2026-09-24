/**
 * Demo end-to-end del engine: EventBus → Engine → Pipeline → Agent → Provider.
 *
 * Usa un `EchoProvider` — NO es el `AnthropicApiProvider` real de v1 (eso
 * sigue pendiente, ver la sesión de research sobre por qué envolverlo no es
 * un wrapper delgado). Este demo prueba que el CABLEADO funciona con las
 * piezas que ya están implementadas de verdad: no hay nada acá que no exista
 * ya en `src/`.
 *
 * Correr: `bun run demo` (desde packages/engine-v2).
 */
import { Agent, ERROR_EXIT, SUCCESS_EXIT } from '../src/engine/Agent.js'
import type { AgentRunContext, AgentRunOutput } from '../src/engine/Agent.js'
import { Engine } from '../src/engine/Engine.js'
import { ExecutionLog } from '../src/engine/ExecutionLog.js'
import { Provider } from '../src/engine/Provider.js'
import { Project } from '../src/domain/Project.js'
import { Repo } from '../src/domain/Repo.js'
import { DomainEvent } from '../src/events/DomainEvent.js'
import { EventBus } from '../src/events/EventBus.js'
import { AgentAction } from '../src/pipeline/actions/AgentAction.js'
import { Pipeline } from '../src/pipeline/Pipeline.js'

/** El provider más simple posible: cierra todo run como éxito, sin correr
 *  ningún modelo de verdad. Sirve para probar el loop completo del engine
 *  sin necesitar credenciales ni el ToolExecutionPort que un provider real
 *  (anthropic-api) necesitaría. */
class EchoProvider extends Provider {
  async run(input: AgentRunContext): Promise<AgentRunOutput> {
    console.log(`  [EchoProvider] corriendo agente "${input.agentId}" — prompt: "${input.prompt}"`)
    return { outcome: SUCCESS_EXIT, summary: 'echo ok' }
  }
}

Project.register(new Project({ id: 'demo-project' }))
Repo.register(new Repo({ name: 'demo-repo', projectId: 'demo-project', path: '/tmp/demo-repo' }))
Provider.register(new EchoProvider({ id: 'echo-provider', kind: 'sync' }))

Agent.register(
  new Agent({
    id: 'echo-agent',
    provider: 'echo-provider',
    prompt: 'Decí que todo salió bien.',
    exits: { [SUCCESS_EXIT]: 'closed', [ERROR_EXIT]: 'failed' },
  }),
)

AgentAction.register('run-echo-agent', new AgentAction({ id: 'run-echo-agent', agentId: 'echo-agent' }))

const pipeline = new Pipeline({
  id: 'demo-pipeline',
  on: ['issue.observed'],
  do: [AgentAction.resolve('run-echo-agent') as AgentAction],
})

const bus = new EventBus()
const engine = new Engine(bus)
engine.register(pipeline)
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
console.log(log.map((entry) => ({ agentId: entry.agentId, outcome: entry.outcome, exit: entry.exit })))

if (log.length === 0 || log[0]?.status !== 'completed') {
  console.error('\n❌ el demo no completó ningún run — revisar el pipeline/wiring')
  process.exit(1)
}
console.log('\n✅ engine-v2 corrió punta a punta: evento → pipeline → agente → provider → log')
