import { createLogger, taggedSync } from '@ia-flow/telemetry'
import { Condition } from '../condition/Condition.js'
import { EventFilter } from '../condition/EventFilter.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import { Pause, TIMEOUT_BRANCH } from '../pipeline/actions/Pause.js'
import type {
  ExecutionHandle,
  PipelineExecutionContext,
  Resumable,
  StepKind,
  StepOutcome,
  StepResume,
} from '../pipeline/Runnable.js'
import { Runnable } from '../pipeline/Runnable.js'
import { type ExitRoutes, resolveRoutes, routeTargets } from '../routing/ExitRoutes.js'
import { unwrapConversation, wrapConversation } from './AgentConversation.js'
import type { AgentDefinitionProps } from './AgentDefinition.js'
import { PromptRenderer, type SystemPromptCatalog } from './PromptRenderer.js'
import {
  providerRegistry as defaultProviderRegistry,
  type ProviderRegistry,
  type ProviderRunOutput,
  toolsFor,
} from './Provider.js'
import { ProviderCandidate } from './ProviderCandidate.js'
import { ProviderSelector, type SelectedProvider } from './ProviderSelector.js'
import type { ToolInputSchema } from './SchemaTool.js'
import { Toolset } from './Toolset.js'
import { TurnProtocol } from './TurnProtocol.js'
import { inboxTag, providerTag } from './tracing.js'
import type { Waiting } from './WaitTool.js'

/** La rama por la que despierta un agente que esperaba (`wait_for_event`): llegó su evento. */
export const WAIT_EVENT_BRANCH = 'event'

/** Cuánto del evento que lo despierta se le muestra al agente. */
const MAX_WAKE_EVENT_CHARS = 12_000

/** Lo que devuelve `Agent.run` y queda en `ctx.steps[id]`. */
export interface AgentRunResult {
  output: ProviderRunOutput
  /** La salida elegida. `undefined` si la corrida se cortó (`truncated`/`cancelled`). */
  exit?: string
  /** Lo que el modelo entregó en `submit_<exit>`: `{ report?, <idDestino>: input, ... }`. */
  payload?: Record<string, unknown>
  /** Si lo interrumpieron y cedió el turno (`yield_turn`): en qué quedó. Sin `exit`. */
  progress?: string
  /** Si pausó su turno esperando un evento (`wait_for_event`): qué espera. Sin `exit`. */
  waiting?: Waiting
  /** El provider en el que corrió (uno de sus candidatos). */
  provider?: string
}

/**
 * Un agente respaldado por un LLM — `Runnable` directo, así que se pone tal cual en
 * `Pipeline.do[]` o como destino de una ruta, con su propio `id` como key de `ctx.steps`.
 *
 * Termina eligiendo una SALIDA (`TurnProtocol`): por cada salida resuelta (ver `resolveRoutes`) el
 * modelo recibe una tool `submit_<salida>` cuyo schema es el input de los pasos a los que lleva.
 * Qué pasos corren después, y en qué orden, lo decide `Pipeline` — el agente sólo reporta qué
 * eligió y con qué datos. El prompt lo arma `PromptRenderer` y las tools `Toolset`.
 */
export class Agent extends Runnable {
  readonly log = createLogger('agent-engine.agent')
  readonly definition: AgentDefinitionProps
  readonly toolset: Toolset
  /** Sus providers candidatos, en orden (`providers`, o el único `provider`). */
  readonly candidates: ProviderCandidate[]
  private readonly selector: ProviderSelector
  private readonly renderer: PromptRenderer
  private readonly injects: EventFilter[]
  private resumable: Resumable | undefined

  constructor(
    definition: AgentDefinitionProps,
    registry: ProviderRegistry = defaultProviderRegistry,
    systemPrompts?: SystemPromptCatalog,
  ) {
    super({
      id: definition.id,
      when: definition.when,
      ...(definition.whenText ? { whenText: definition.whenText } : {}),
      continueOnError: definition.continueOnError,
    })
    this.definition = definition
    this.candidates = candidatesOf(definition)
    this.selector = new ProviderSelector(
      definition.id,
      definition.maxConcurrent,
      this.candidates,
      registry,
      this.log,
    )
    this.renderer = new PromptRenderer(systemPrompts)
    this.injects = (definition.injects ?? []).map((filter) => new EventFilter(filter))
    this.assertBaseRoutesTargetActions()
    this.toolset = new Toolset(definition.id, definition.tools, definition.actions)
  }

  override get kind(): StepKind {
    return 'agent'
  }

  /** Las rutas BASE del agente — la pipeline las sobrescribe o elimina (ver `resolveRoutes`). */
  override get exitRoutes(): ExitRoutes {
    const { routes, onError, onInterrupt, report } = this.definition
    return { routes, onError, onInterrupt, report }
  }

  override acceptsInput(): ToolInputSchema | undefined {
    return this.definition.input
  }

  /** Un agente que eligió una salida la entrega con su payload; uno cortado (`truncated`,
   *  `cancelled`) es un output a secas. */
  override outcome(output: unknown): StepOutcome {
    const result = output as AgentRunResult
    if (result.waiting) return { kind: 'pause', pause: this.pauseFor(result) }
    if (result.exit === undefined) return { kind: 'output', output }
    return { kind: 'exit', output, exit: result.exit, payload: result.payload ?? {} }
  }

  /** Un agente que puede esperar (`waits`) es una pausa de la pipeline: se retoma a sí mismo, por
   *  el evento que esperaba o porque venció el plazo. */
  override asResumable(): Resumable | undefined {
    if (!this.definition.waits) return undefined
    this.resumable ??= {
      id: this.definition.id,
      branchNames: [WAIT_EVENT_BRANCH, TIMEOUT_BRANCH],
      targetsOf: () => [this],
      allTargets: [this],
    }
    return this.resumable
  }

  /** Si `event` pasa alguno de sus `injects`. */
  override accepts(event: DomainEvent<any>): boolean {
    return this.injects.some((filter) => filter.matches(event))
  }

  async run(ctx: PipelineExecutionContext, input?: unknown): Promise<AgentRunResult> {
    const def = this.definition
    const parsedInput = this.parseInput(def.input, input) ?? {}
    const routes =
      ctx.routesFor?.(this) ?? resolveRoutes(def.id, this.exitRoutes, { project: ctx.defaults })
    // Retoma su propia conversación (esperaba un evento, o el proceso murió mientras corría): el
    // `onStart` ya corrió la primera vez.
    const resume = ctx.resume?.step === def.id ? ctx.resume : undefined

    if (!resume) await this.runOnStart(ctx)

    const variables = def.variables ?? {}
    const { prompt, systemPrompts } = this.renderer.render(
      def.prompt,
      ctx,
      parsedInput,
      variables,
      def.systemPrompts ?? [],
    )
    // Mientras el provider corre, este agente es el paso activo: se le ofrece lo que llega a la
    // task, y recibe lo que acepta (`injects`) — o el aviso de que lo interrumpieron.
    const execution = ctx.execution
    const turn = new TurnProtocol(
      def.id,
      routes,
      execution ? () => execution.interruption !== undefined : undefined,
      def.waits,
    )
    const tools = this.toolset.forRun(ctx, turn.tools)
    const message = resume ? wakeMessage(resume) : undefined
    const saved = resume?.state !== undefined ? unwrapConversation(resume.state) : undefined

    // Una conversación se retoma en el provider que la armó; si ya no es candidato, se empieza de
    // nuevo en el que toque, sabiendo qué pasó.
    const selected = this.chosen(await this.selector.select(ctx, saved?.provider))
    const { candidate, provider } = selected
    const conversation =
      saved && (saved.provider === undefined || saved.provider === candidate.id)
        ? saved.conversation
        : undefined
    execution?.enter(this)
    const output = await provider
      .run({
        agentId: def.id,
        prompt: message && conversation === undefined ? `${prompt}\n\n${message}` : prompt,
        systemPrompts,
        variables,
        providerConfig: candidate.config,
        mcpServers: def.mcpServers ?? [],
        tools: toolsFor(provider, tools),
        ctx,
        ...(ctx.onText ? { onText: ctx.onText } : {}),
        ...(execution ? { inbox: () => this.readInbox(execution) } : {}),
        ...(message && conversation !== undefined ? { resume: { conversation, message } } : {}),
        ...(ctx.saveProgress
          ? {
              saveConversation: (state: unknown) =>
                ctx.saveProgress?.(this, wrapConversation(candidate.id, state)),
            }
          : {}),
      })
      .finally(() => {
        execution?.leave(this)
        selected.release()
        ctx.saveProgress?.(this, undefined)
      })

    return { ...turn.resolve(output), provider: candidate.id }
  }

  /** El provider elegido, en la traza (`providerTag`). */
  @taggedSync(providerTag)
  private chosen(selected: SelectedProvider): SelectedProvider {
    return selected
  }

  /** La pausa de un agente que espera: su evento, o que venza el plazo — y la conversación, para
   *  seguirla al despertar. */
  private pauseFor({ waiting, output, provider }: AgentRunResult): Pause {
    const { on, when, timeoutMs } = waiting as Waiting
    return new Pause(
      this.definition.id,
      [
        {
          name: WAIT_EVENT_BRANCH,
          filter: new EventFilter({ on, when: Condition.fromRows(when) }),
        },
      ],
      Date.now() + timeoutMs,
      output.conversation !== undefined && provider
        ? wrapConversation(provider, output.conversation)
        : output.conversation,
    )
  }

  /** Los pasos de `onStart`, en orden. Dentro de una pipeline corren como sus pasos (su `when`,
   *  su span), pero si uno tira el agente no arranca: el error es del agente, no de ese paso. */
  private async runOnStart(ctx: PipelineExecutionContext): Promise<void> {
    for (const step of [this.definition.onStart ?? []].flat()) {
      if (ctx.runStep) await ctx.runStep(step, `onStart:${this.id}`)
      else await step.run(ctx)
    }
  }

  /** Lo inyectado desde la última vuelta, para el provider. Deja en la traza del agente cuándo
   *  lo leyó (`inboxTag`). */
  @taggedSync(inboxTag)
  private readInbox(execution: ExecutionHandle): string[] {
    return execution.drain(this)
  }

  /** Encadenar agentes lo decide la pipeline, donde se ve el grafo completo: una ruta BASE que
   *  apuntara a otro agente arrastraría su grafo a cualquier pipeline que incluya a éste. */
  private assertBaseRoutesTargetActions(): void {
    const def = this.definition
    const targets = [
      ...Object.values(def.routes ?? {}).flatMap((route) => routeTargets(route?.to)),
      ...routeTargets(def.onError?.to),
    ]
    const agent = targets.find((target) => target.kind === 'agent')
    if (agent) {
      throw new Error(
        `Agent(${def.id}): una ruta base apunta al agente "${agent.id}" — encadenar agentes se declara en la pipeline`,
      )
    }
  }
}

/** Lo que lee el agente al retomar: qué pasó mientras no estaba. */
function wakeMessage({ branch, event, note }: StepResume): string {
  if (note) return note
  if (branch === TIMEOUT_BRANCH) {
    return 'Venció la espera sin que llegara el evento que esperabas. Seguí con lo que tengas, o terminá tu turno.'
  }
  const payload = JSON.stringify(event.payload, null, 2)
  const shown =
    payload.length > MAX_WAKE_EVENT_CHARS
      ? `${payload.slice(0, MAX_WAKE_EVENT_CHARS)}\n…(recortado)`
      : payload
  return `Llegó el evento que esperabas (${event.type}):\n\n${shown}\n\nSeguí con tu trabajo.`
}

/** Los candidatos de una definición: `providers`, o el atajo `provider` + `providerConfig`. */
function candidatesOf(def: AgentDefinitionProps): ProviderCandidate[] {
  if (def.providers && def.provider) {
    throw new Error(`Agent(${def.id}): declará \`provider\` o \`providers\`, no los dos`)
  }
  if (def.providers) {
    if (def.providers.length === 0) throw new Error(`Agent(${def.id}): \`providers\` vacío`)
    return def.providers.map((choice) => new ProviderCandidate(choice))
  }
  if (!def.provider) throw new Error(`Agent(${def.id}): falta \`provider\` (o \`providers\`)`)
  return [
    new ProviderCandidate({
      id: def.provider,
      ...(def.providerConfig ? { config: def.providerConfig } : {}),
    }),
  ]
}
