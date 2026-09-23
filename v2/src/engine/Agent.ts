import type { Task } from '../domain/Task.js'
import { Step, type StepContext } from './Step.js'

export interface ProviderRef {
  id: string
  /** 'sync' (anthropic-api) corre y devuelve; 'async' (tmux/iterm/remote) corre en otro proceso. */
  kind: 'sync' | 'async'
}

export interface AgentExit {
  outcome: string
  toStatus?: string
  comment?: 'issue' | 'pr' | 'pr-else-issue'
  isDefault?: boolean
}

export interface AgentDefinitionProps {
  id: string
  name: string
  prompt: string
  provider: ProviderRef
  tools: string[]
  exits: AgentExit[]
  systemPromptRefs?: string[]
  maxConcurrentDispatches?: number
}

export interface AgentRunInput {
  task: Task
  /** Contexto acotado cuando este Agent corre como sub-agente de otro (run_agent en v1). */
  brief?: string
}

export interface AgentRunOutput {
  outcome: string
  exit: AgentExit
  summary?: string
}

/**
 * Identidad + capacidad de un agente: qué tools tiene, con qué provider corre,
 * y cómo cierra (exits). NO sabe cuándo le toca correr — eso es de Rule.when
 * en v2 (en v1 vivía en AgentActivationSchema; ver migración 059-activation-into-rules).
 */
export class Agent extends Step<AgentRunInput, AgentRunOutput> {
  readonly kind = 'agent'
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly provider: ProviderRef
  readonly tools: string[]
  readonly exits: AgentExit[]
  readonly systemPromptRefs: string[]
  readonly maxConcurrentDispatches?: number

  constructor(props: AgentDefinitionProps) {
    super()
    this.id = props.id
    this.name = props.name
    this.prompt = props.prompt
    this.provider = props.provider
    this.tools = props.tools
    this.exits = props.exits
    this.systemPromptRefs = props.systemPromptRefs ?? []
    this.maxConcurrentDispatches = props.maxConcurrentDispatches
  }

  async run(input: AgentRunInput, ctx: StepContext): Promise<AgentRunOutput> {
    await this.onStart(input.task)
    const outcome = await this.execute(input, ctx)
    return this.finalize(outcome, input.task)
  }

  /** Marca el task como working en la fuente (setAgentWorking en v1). */
  protected async onStart(task: Task): Promise<void> {
    throw new Error('not implemented')
  }

  /** Llama al IAgentProvider y corre su loop de tools hasta terminar o fallar. */
  protected async execute(input: AgentRunInput, ctx: StepContext): Promise<string> {
    throw new Error('not implemented')
  }

  /** Matchea el outcome contra this.exits, aplica la transición y graba el ExecutionLog. */
  protected finalize(outcome: string, task: Task): AgentRunOutput {
    throw new Error('not implemented')
  }

  matchExit(outcome: string): AgentExit | undefined {
    return this.exits.find((e) => e.outcome === outcome) ?? this.exits.find((e) => e.isDefault)
  }
}
