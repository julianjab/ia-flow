import {
  EventBus,
  type Provider,
  type ProviderRunContext,
  type ProviderRunOutput,
  type Tool,
} from '@ia-flow/agent-engine'
import { RemoteProvider, type RemoteProviderOptions } from '../RemoteProvider.js'
import { RemoteProviderHost, type RemoteProviderHostOptions } from '../RemoteProviderHost.js'

export const TOKEN = 'secreto'

/** Un provider local de mentira: lo que hace cada corrida lo decide el test. */
export class ScriptedProvider implements Provider {
  readonly runs: ProviderRunContext[] = []
  constructor(
    readonly id: string,
    private readonly script: (ctx: ProviderRunContext) => Promise<ProviderRunOutput>,
    readonly maxConcurrent?: number,
  ) {}

  run(ctx: ProviderRunContext): Promise<ProviderRunOutput> {
    this.runs.push(ctx)
    return this.script(ctx)
  }
}

export function makeHost(
  providers: Provider[],
  options: Partial<RemoteProviderHostOptions> = {},
): RemoteProviderHost {
  return new RemoteProviderHost({ providers, token: TOKEN, sweepIntervalMs: 0, ...options })
}

/** Un `fetch` que le pega directo al handler del host, sin red. */
export function wire(host: RemoteProviderHost): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    host.fetch(new Request(input, init))) as typeof fetch
}

export function makeClient(
  host: RemoteProviderHost | typeof fetch,
  options: Partial<RemoteProviderOptions> = {},
): RemoteProvider {
  return new RemoteProvider({
    id: 'remote',
    provider: 'local',
    url: 'http://host.test',
    token: TOKEN,
    fetchImpl: typeof host === 'function' ? host : wire(host),
    timing: {
      longPollMs: 200,
      requestSlackMs: 500,
      retryDelayMs: 10,
      busyRetryMs: 10,
      unreachableRetryMs: 10,
    },
    ...options,
  })
}

export function runContext(overrides: Partial<ProviderRunContext> = {}): ProviderRunContext {
  return {
    agentId: 'implementer',
    prompt: 'hacé la tarea',
    systemPrompts: ['sos un agente'],
    variables: {},
    providerConfig: {},
    mcpServers: [],
    tools: [],
    ctx: {
      event: {
        id: 'e1',
        type: 'github.issues',
        payload: { owner: 'la-haus', repo: 'eks', number: 7 },
        scope: { projectId: 'p1' },
        occurredAt: '2026-09-29T00:00:00.000Z',
        depth: 0,
      },
      steps: {},
      bus: new EventBus(),
      pipelineId: 'build',
    },
    ...overrides,
  }
}

export function tool(name: string, handler: Tool['handler'], extra: Partial<Tool> = {}): Tool {
  return { name, description: name, inputSchema: { type: 'object' }, handler, ...extra }
}

/** La tool `name` del contexto del provider local (un proxy hacia el runner). */
export function call(ctx: ProviderRunContext, name: string, input: unknown = {}) {
  const found = ctx.tools.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`sin tool ${name}`)
  return found.handler(input)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
