import type { Task } from '../domain/Task.js'
import type { Condition } from '../rules/Condition.js'

export type CommentTarget = 'issue' | 'pr' | 'pr-else-issue' | 'none'

/** Salida corta: sólo el nombre de status (`$set:`). Salida larga: además
 *  declara cuándo usarla (viaja al enum de `select_exit`) y dónde comentar. */
export type AgentExit = string | { set: string; when?: string; comment?: CommentTarget }

export const SUCCESS_EXIT = 'success'
export const ERROR_EXIT = 'error'

export function exitSet(exit: AgentExit | undefined): string | undefined {
  if (exit == null) return undefined
  return typeof exit === 'string' ? exit : exit.set
}

export function exitComment(exit: AgentExit | undefined): CommentTarget | undefined {
  return exit == null || typeof exit === 'string' ? undefined : exit.comment
}

/** salida > agente > default ('pr-else-issue'). */
export function resolveCommentTarget(
  exit: AgentExit | undefined,
  agentDefault: CommentTarget | undefined,
): CommentTarget {
  return exitComment(exit) ?? agentDefault ?? 'pr-else-issue'
}

export interface AgentProviderChoice {
  providerId: string
  when?: Condition[]
  whenText?: string
}

/** string = un solo provider, resuelto directo. Array = varios candidatos,
 *  desempatados por `when`/`whenText` (o un clasificador si hay >1 y ninguno resuelve). */
export type AgentProvider = string | AgentProviderChoice[]

export interface BashRunConfig {
  name: 'bash_run'
  allow: string[]
  deny: string[]
}

export type AgentToolEntry = string | BashRunConfig

export type AgentVariableValue = string | { value: string; full?: string; description?: string }

export interface AgentOutputField {
  type: 'string' | 'number' | 'boolean'
  description?: string
  enum?: string[]
  optional?: boolean
}

export type AgentOutput = Record<string, AgentOutputField>

export interface SystemPromptRef {
  id?: string
  text?: string
}

export interface AgentDefinitionProps {
  id: string
  provider: AgentProvider
  prompt: string
  systemPrompts?: SystemPromptRef[]
  variables?: Record<string, AgentVariableValue>
  tools?: AgentToolEntry[]
  saveOutput?: boolean
  providerConfig?: Record<string, unknown>
  mcpCatalogIds?: string[]
  requiresBranch?: boolean
  maxConcurrentDispatches?: number
  /** Corre igual aunque el issue esté bloqueado por otro (tolerancia de trabajo,
   *  no criterio de activación — por eso sobrevivió a la migración a Rule). */
  allowBlocked?: boolean
  /** Dueño de la fila para edición/visibilidad — NO es activación. */
  projectId?: string | null
  /** Orden en el editor, dentro de su ámbito — presentación, no criterio de match. */
  position?: number
  /** Contrato de `submit_output`, opt-in — vuelve obligatorio llamarlo antes de cerrar. */
  output?: AgentOutput
  /** Comandos que corre el ENGINE (no el modelo) en el worktree tras el loop. */
  verify?: string[]
  /** Hook: corre siempre al arrancar el run, no es una salida elegible. */
  onProcess?: string
  exits?: Record<string, AgentExit>
  /** Destino default de todos los comentarios de este agente. */
  comment?: CommentTarget
}

export interface AgentRunInput {
  task: Task
  /** Obligatorio cuando este Agent corre como sub-agente (run_agent en v1) —
   *  el hijo no hereda contexto del padre. */
  brief?: string
}

export interface AgentRunOutput {
  outcome: string
  exit?: AgentExit
  summary?: string
  /** Presente si `output` está declarado y el agente llamó a submit_output. */
  structuredOutput?: Record<string, unknown>
}

/**
 * Identidad + capacidad de un agente: qué tools tiene, con qué provider corre,
 * y cómo cierra (exits). NO sabe cuándo le toca correr — eso es 100% de
 * Rule.when/on (en v1 vivía en AgentActivationSchema; ver migración
 * 059-activation-into-rules). Un Agent vive en el AgentRegistry y las Rule lo
 * referencian por id — nunca se embebe en una cadena de `do`.
 */
export class Agent {
  readonly id: string
  readonly provider: AgentProvider
  readonly prompt: string
  readonly systemPrompts: SystemPromptRef[]
  readonly variables: Record<string, AgentVariableValue>
  readonly tools: AgentToolEntry[]
  readonly saveOutput: boolean
  readonly providerConfig: Record<string, unknown>
  readonly mcpCatalogIds: string[]
  readonly requiresBranch?: boolean
  readonly maxConcurrentDispatches?: number
  readonly allowBlocked: boolean
  readonly projectId: string | null
  readonly position: number
  readonly output?: AgentOutput
  readonly verify: string[]
  readonly onProcess?: string
  readonly exits: Record<string, AgentExit>
  readonly comment?: CommentTarget

  constructor(props: AgentDefinitionProps) {
    this.id = props.id
    this.provider = props.provider
    this.prompt = props.prompt
    this.systemPrompts = props.systemPrompts ?? []
    this.variables = props.variables ?? {}
    this.tools = props.tools ?? []
    this.saveOutput = props.saveOutput ?? false
    this.providerConfig = props.providerConfig ?? {}
    this.mcpCatalogIds = props.mcpCatalogIds ?? []
    this.requiresBranch = props.requiresBranch
    this.maxConcurrentDispatches = props.maxConcurrentDispatches
    this.allowBlocked = props.allowBlocked ?? false
    this.projectId = props.projectId ?? null
    this.position = props.position ?? 0
    this.output = props.output
    this.verify = props.verify ?? []
    this.onProcess = props.onProcess
    this.exits = props.exits ?? {}
    this.comment = props.comment
  }

  /**
   * onStart marca el issue como working ANTES de que exista ninguna forma de
   * revertir esa marca salvo terminar el run — así que todo lo que sigue va
   * en un try/catch que embudea cualquier falla (de execute, de verify, o un
   * throw inesperado) hacia finalize(ERROR_EXIT, ...) en vez de propagar y
   * dejar el issue trabado hasta el próximo crashRecovery.
   */
  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    await this.onStart(input.task)
    let outcome: string
    try {
      outcome = await this.execute(input)
      outcome = await this.verifyWorktree(input.task, outcome)
    } catch {
      outcome = ERROR_EXIT
    }
    return this.finalize(outcome, input.task)
  }

  /** Marca el task como working en la fuente (setAgentWorking en v1). */
  protected async onStart(task: Task): Promise<void> {
    throw new Error('not implemented')
  }

  /** Resuelve el provider (this.provider), corre el loop de tools hasta terminar o fallar. */
  protected async execute(input: AgentRunInput): Promise<string> {
    throw new Error('not implemented')
  }

  /**
   * Corre this.verify[] en el worktree DESPUÉS de execute y ANTES de finalize
   * — es lo único que puede todavía cambiar el outcome antes de que se
   * aplique una transición. Un exit != 0 devuelve ERROR_EXIT (failureClass
   * `verify_failed`) en vez del outcome recibido; no corre si outcome ya es
   * error/truncated/cancelled.
   */
  protected async verifyWorktree(task: Task, outcome: string): Promise<string> {
    throw new Error('not implemented')
  }

  /** Matchea el outcome contra this.exits, aplica la transición y graba el ExecutionLog. */
  protected async finalize(outcome: string, task: Task): Promise<AgentRunOutput> {
    throw new Error('not implemented')
  }

  matchExit(outcomeName: string): AgentExit | undefined {
    return (
      this.exits[outcomeName] ?? this.exits[outcomeName === 'success' ? SUCCESS_EXIT : ERROR_EXIT]
    )
  }

  hasWriteTools(): boolean {
    throw new Error('not implemented — intersectWritePaths/hasWriteTools de v1')
  }
}
