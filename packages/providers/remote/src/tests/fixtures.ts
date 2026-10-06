import {
  createEvent,
  EventBus,
  ProviderRegistry,
  type ProviderRunContext,
  type Tool,
} from '@ia-flow/agent-engine'
import { HostClient, type TaskRunner } from '../HostClient.js'
import type { AcceptRow, HostTask, RunResult } from '../protocol.js'
import { RemoteHub } from '../RemoteHub.js'
import { RunnerLink } from '../RunnerLink.js'

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

/** Lo que hace el provider del host al llamar una tool del engine: `/tools` de la corrida. */
export async function callTool(
  hub: RemoteHub,
  task: HostTask,
  name: string,
  input: unknown = {},
): Promise<{ text: string; isError: boolean }> {
  const res = await post(hub, `${RUNNER}${task.endpoints.tools}`, { name, input })
  return (await res.json()) as { text: string; isError: boolean }
}

/** Un POST a una ruta del hub, sin red. */
export function post(hub: RemoteHub, url: string, body: unknown): Promise<Response> {
  return wire(hub)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Un resultado como el que devuelve el provider del host. */
export function output(outcome = 'success', extra: Record<string, unknown> = {}): RunResult {
  return { status: 'output', output: { outcome, ...extra } }
}

/** El `RunnerLink` de una tarea, contra el hub sin red. */
export function link(hub: RemoteHub, task: HostTask, inboxEveryMs = 5): RunnerLink {
  return new RunnerLink({ task, base: RUNNER, fetchImpl: wire(hub), inboxEveryMs, textEveryMs: 5 })
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
