import {
  createEvent,
  EventBus,
  ProviderRegistry,
  type ProviderRunContext,
  type Tool,
} from '@ia-flow/agent-engine'
import { HostClient, type TaskRunner } from '../HostClient.js'
import type { AcceptRow } from '../protocol.js'
import { RemoteHub } from '../RemoteHub.js'

export const TOKEN = 'secreto-de-hosts'
export const RUNNER = 'http://runner.test'

/** Un `fetch` que le pega directo al hub, sin red. */
export function wire(hub: RemoteHub): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    (await hub.fetch(new Request(input, init))) ??
    new Response('no es del hub', { status: 404 })) as typeof fetch
}

export function makeHub(overrides: Partial<ConstructorParameters<typeof RemoteHub>[0]> = {}) {
  const registry = new ProviderRegistry()
  const hub = new RemoteHub({
    registry,
    token: TOKEN,
    longPollMs: 30,
    sweepIntervalMs: 0,
    ...overrides,
  })
  return { hub, registry }
}

export function makeHost(
  hub: RemoteHub,
  run: TaskRunner,
  options: { name?: string; maxConcurrent?: number; accepts?: AcceptRow[]; token?: string } = {},
): HostClient {
  return new HostClient({
    runnerUrl: RUNNER,
    token: options.token ?? TOKEN,
    name: options.name ?? 'laptop',
    maxConcurrent: options.maxConcurrent ?? 1,
    accepts: options.accepts ?? [],
    run,
    fetchImpl: wire(hub),
    retryMs: 10,
  })
}

/** Lo que haría la sesión del CLI allá: llamar una tool por el MCP de la corrida en el runner. */
export async function callTool(
  hub: RemoteHub,
  url: string,
  name: string,
  args: unknown = {},
): Promise<{ text: string; isError?: boolean }> {
  const res = await wire(hub)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const body = (await res.json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean }
  }
  return { text: body.result.content[0]?.text ?? '', isError: body.result.isError }
}

export function tool(name: string, handler: Tool['handler'], extra: Partial<Tool> = {}): Tool {
  return { name, description: name, inputSchema: { type: 'object' }, handler, ...extra }
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
      event: createEvent('issue.status_changed', { owner: 'la-haus', repo: 'eks', number: 7 }),
      steps: {},
      bus: new EventBus(),
      pipelineId: 'build',
    },
    ...overrides,
  }
}

/** Hasta que `check` dé true (o se agote). */
export async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando la condición')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
