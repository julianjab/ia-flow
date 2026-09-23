import type { Task } from '../domain/Task.js'
import { Conditional, type ConditionalProps } from '../rules/Conditional.js'

export type CommentTarget = 'issue' | 'pr' | 'pr-else-issue' | 'none'

/** Salida corta: sólo el nombre de status (`$set:`). Salida larga: además
 *  declara cuándo usarla (viaja al enum de `select_exit`) y dónde comentar. */
export type AgentExit = string | { set: string; when?: string; comment?: CommentTarget }

export const SUCCESS_EXIT = 'success'
export const ERROR_EXIT = 'error'

/** Outcomes que NO aplican ninguna transición — el run se cortó desde afuera
 *  (cancel manual, upstream abort truncando el stream), no es un resultado
 *  del agente. Ver Agent.matchExit. */
export const NO_TRANSITION_OUTCOMES = ['cancelled', 'truncated'] as const
export type NoTransitionOutcome = (typeof NO_TRANSITION_OUTCOMES)[number]

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

export interface AgentProviderChoiceProps extends ConditionalProps {
  providerId: string
}

/** Un candidato dentro de un `Agent.provider` array. Hereda `when`/`whenText`
 *  de `Conditional` — acá desempatan entre VARIOS providers candidatos, a
 *  diferencia del `whenText` de `Rule`/`AgentActivation`, que decide si el
 *  ÚNICO candidato corre o no. Mismo campo, semántica distinta por contexto. */
export class AgentProviderChoice extends Conditional {
  readonly providerId: string

  constructor(props: AgentProviderChoiceProps) {
    super(props)
    this.providerId = props.providerId
  }
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
  /** Schema que el output ESTRUCTURADO de este run debería cumplir, cuando
   *  el próximo `do` de la cadena es un agente que lo necesita como input
   *  tipado (viaja desde RuleExecutionContext.nextSchema). Ausente: el
   *  agente corre con su propio `output` declarado, sin hand-off. */
  expectedOutput?: AgentOutput
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
   * dejar el issue trabado hasta el próximo crashRecovery. El error se le
   * pasa a finalize (no se descarta) para que el ExecutionLog y el comentario
   * de cierre puedan explicar POR QUÉ falló, no sólo que falló.
   */
  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    await this.onStart(input.task)
    let outcome: string
    let error: unknown
    try {
      outcome = await this.execute(input)
      outcome = await this.verifyWorktree(input.task, outcome)
    } catch (err) {
      outcome = ERROR_EXIT
      error = err
    }
    return this.finalize(outcome, input.task, error)
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

  /**
   * Matchea el outcome contra this.exits, aplica la transición y graba el
   * ExecutionLog. `error` viene seteado cuando run() capturó una falla de
   * execute/verify — su mensaje va al ExecutionLog y al comentario de cierre.
   * Tiene que ser resiliente (mismo motivo que safeUpdateLog/safeInsertLog en
   * execution-log.ts de v1): un fallo ACÁ no puede dejar agent_working=true
   * sin aplicar ningún exit, porque run() ya no tiene otro punto de recuperación.
   */
  protected async finalize(outcome: string, task: Task, error?: unknown): Promise<AgentRunOutput> {
    throw new Error('not implemented')
  }

  /**
   * Matchea un outcome (el que puso `execute`/`verifyWorktree`, o el `exit`
   * que el modelo eligió vía `select_exit`) contra `this.exits`.
   *
   * `cancelled`/`truncated` devuelven `undefined` A PROPÓSITO — no son un
   * fallo del agente, son el run cortado desde afuera (cancel manual,
   * upstream abort, límite de tool-use truncado). Aplicarles ERROR_EXIT
   * comentaría un fallo que no ocurrió y movería el issue a donde v1 mueve
   * un error real. `finalize` no aplica ninguna transición cuando esto
   * devuelve `undefined` — mismo comportamiento que Agent.ts en v1.
   *
   * Cualquier otro nombre que no está en `this.exits` cae a `ERROR_EXIT`: es
   * la red para un outcome desconocido, pero el nombre bien formado (que
   * venga de `select_exit`) tiene que validarse ANTES de esto —
   * `AgentRegistry.register` es donde correspondería rechazar un agente cuyo
   * `output`/exits declaran algo inconsistente, no acá en cada run.
   */
  matchExit(outcomeName: string): AgentExit | undefined {
    if (NO_TRANSITION_OUTCOMES.includes(outcomeName as NoTransitionOutcome)) return undefined
    return this.exits[outcomeName] ?? this.exits[ERROR_EXIT]
  }

  hasWriteTools(): boolean {
    throw new Error('not implemented — intersectWritePaths/hasWriteTools de v1')
  }
}
