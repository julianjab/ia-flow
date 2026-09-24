import type { IAgentProvider, ProviderInput, ProviderOutput } from '@ia-flow/ai-providers'
import {
  type AgentRunContext,
  type AgentRunOutput,
  Provider,
  type WorkspacePlan,
  type WorkspaceRequest,
} from '@ia-flow/engine-v2'
import type { WorkspaceRequest as V1WorkspaceRequest } from '@ia-flow/shared'

/**
 * Envuelve CUALQUIER `IAgentProvider` de v1 (anthropic-api, tmux-claude,
 * iterm-claude, un `remote:*`) detrás del `Provider` abstracto de v2 — una
 * sola clase, no una por provider, porque los cuatro ya comparten el MISMO
 * contrato en v1 (`run`/`canAccept`/`prepareWorkspace`). El composition root
 * de `apps/server` instancia una por cada entrada de `providerRegistry.list()`.
 *
 * No reimplementa NADA de lo que hace un provider real — sólo traduce forma.
 * El provider v1 ya viene armado con sus propios ports inyectados
 * (`ToolExecutionPort`, `loadProviderConfig`, `WorkspaceProvisionerPort`) por
 * el composition root de v1; este adapter nunca los toca.
 *
 * Limitaciones conocidas y deliberadas de esta primera versión — no son
 * bugs, son alcance no cubierto todavía:
 * - `IAgentProvider.canAccept` (v1) exige un `Task` completo en su request —
 *   algo que v2 deliberadamente no tiene ni le pasa a `Provider.canAccept`
 *   (`AdmissionRequest` de v2 es `{agentId?, running, cap?}`, sin payload).
 *   Sin un `Task` real que ofrecerle, este adapter NO llama a
 *   `inner.canAccept` — usa el default de `Provider` (sólo el cap
 *   declarado). Un provider que rechace "por lo que la tarea ES" (repo sin
 *   clonar, tamaño) no puede hacerlo todavía desde acá.
 * - `ProviderInput.step`/`WorkspaceRequest.step` (v1) no tienen equivalente
 *   en v2 — el modelo de Pipeline genérica reemplaza el pipeline fijo
 *   refine/build/review que `StepType` codifica. Se manda `'implement'`
 *   siempre; sólo importa para resolver config por-step, que acá ya no
 *   aplica porque el provider concreto YA está resuelto antes de llegar acá.
 * - Interpolación de variables (`{{project.repos}}`, `{{task.*}}`, etc.)
 *   NO está portada — `input.prompt`/`input.brief` viajan concatenados tal
 *   cual. Un agente v2 cuyo prompt dependa de esas plantillas no va a
 *   renderizar lo que espera hasta que se porte `variable-resolver.ts`.
 * - `drainMessages`/`onMessagesDelivered`/`resumeMessages`/`saveCheckpoint`
 *   (mensajes en vivo, pausas reanudables) no están cableados — un run que
 *   los necesite corre igual, pero sin esa capacidad.
 */
export class V1ProviderAdapter extends Provider {
  constructor(
    private readonly inner: IAgentProvider,
    opts: { maxConcurrentRuns?: number } = {},
  ) {
    super({ id: inner.id, kind: inner.kind, maxConcurrentRuns: opts.maxConcurrentRuns })
  }

  override async prepareWorkspace(req: WorkspaceRequest): Promise<WorkspacePlan> {
    if (this.inner.prepareWorkspace == null) return super.prepareWorkspace(req)
    return this.inner.prepareWorkspace(this.toV1WorkspaceRequest(req))
  }

  async run(input: AgentRunContext): Promise<AgentRunOutput> {
    const output = await this.inner.run(this.toProviderInput(input))
    return this.toAgentRunOutput(output)
  }

  private toV1WorkspaceRequest(req: WorkspaceRequest): V1WorkspaceRequest {
    return { ...req, step: 'implement' }
  }

  /**
   * `payload` es opaco para el engine (por diseño), pero acá SÍ hay que
   * leerlo — es lo único que trae `id`/`title`/`description`/`type` para
   * armar el `ProviderInput` que v1 espera. Convención por nombre, mismo
   * criterio que `Agent.finalize()` usa para `payload.status`.
   */
  private toProviderInput(input: AgentRunContext): ProviderInput {
    const payload = input.payload ?? {}
    const taskId = typeof payload.id === 'string' ? payload.id : crypto.randomUUID()
    const repos = input.workspace?.repos.map((r) => r.name) ?? []
    const repoPaths = Object.fromEntries(
      (input.workspace?.repos ?? [])
        .filter((r) => r.path != null)
        .map((r) => [r.name, r.path as string]),
    )
    const prompt = input.brief != null ? `${input.brief}\n\n${input.prompt}` : input.prompt

    return {
      step: 'implement',
      agentId: input.agentId,
      taskId,
      taskTitle: typeof payload.title === 'string' ? payload.title : '',
      taskDescription: typeof payload.description === 'string' ? payload.description : '',
      taskType: typeof payload.type === 'string' ? payload.type : '',
      repos,
      repoPaths,
      prompt,
      systemPromptBlocks: input.systemPrompts.map((text) => ({ type: 'text' as const, text })),
      tools: (input.tools ?? []).map((t) => (typeof t === 'string' ? t : t.name)),
      outputFields: input.expectedOutput,
      providerConfig: input.providerConfig as ProviderInput['providerConfig'],
      workflow: input.workspace?.workflow,
      branch: input.workspace?.branch,
      workspace: input.workspace != null ? this.toV1WorkspaceRequest(input.workspace) : undefined,
    }
  }

  private toAgentRunOutput(output: ProviderOutput): AgentRunOutput {
    // `outcome` es el string que Agent.matchExit() compara contra
    // `Agent.exits` — v1 no tiene un campo homónimo en ProviderOutput (su
    // Agent.ts lo deriva de stopReason/truncated/cancelación, ver el research
    // de esta sesión), así que se replica ACÁ la misma derivación mínima.
    const outcome = output.truncated ? 'truncated' : 'success'
    return { outcome, summary: output.content }
  }
}
